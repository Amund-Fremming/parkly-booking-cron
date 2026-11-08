import { chromium } from 'playwright';
import cron from 'node-cron';

const { PARKLY_URL, PARKLY_EMAIL, PARKLY_PASSWORD } = process.env;
const MAX_ATTEMPTS = 3;
const timezone = 'Europe/Oslo';

const log = (...args) => console.log(new Date().toISOString(), ...args);

async function enableSemantics(page) {
  await page.locator('flt-semantics-placeholder').dispatchEvent('click');
}

async function login(page) {
  await page.goto(PARKLY_URL);
  await enableSemantics(page);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await page.locator('#signInName').fill(PARKLY_EMAIL);
  await page.locator('#password').fill(PARKLY_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(`${PARKLY_URL}**`);
  await page.waitForLoadState('networkidle');
  await enableSemantics(page);
}

async function withPage(action) {
  const browser = await chromium.launch({ headless: Boolean(process.env.CI) });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  try {
    await login(page);
    return await action(page);
  } finally {
    await browser.close();
  }
}

async function openReservations(page) {
  await page.goto(PARKLY_URL);
  await enableSemantics(page);
  await page.getByRole('button', { name: /^Reservations/ }).click();
  await page.getByRole('switch', { name: 'Show only available days' }).waitFor();
  await page.waitForLoadState('networkidle');
}

async function readReservations(page) {
  const text = await page.locator('flt-semantics[role=group]').first().innerText();
  const count = Number(text.match(/My reservations \((\d+)\)/)?.[1] ?? 0);
  const todaySection = text.split(/Today\n/)[1]?.split(/\n.*Tomorrow/)[0] ?? '';
  return { count, todayAvailable: /\d+ available/.test(todaySection) };
}

async function tryBook(page) {
  const { count } = await readReservations(page);
  await page.getByRole('button', { name: /available/ }).first().click();
  await page
    .locator('flt-semantics[role=group]', { hasText: `My reservations (${count + 1})` })
    .waitFor({ timeout: 10000 });
  return true;
}

async function bookingFlow(page) {
  await openReservations(page);
  const { count, todayAvailable } = await readReservations(page);
  if (count > 0) return 'already booked';
  if (!todayAvailable) return 'not available';
  await tryBook(page);
  return 'booked';
}

async function bookIfNeeded(page) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    log(`booking attempt ${attempt}/${MAX_ATTEMPTS}`);
    try {
      return await bookingFlow(page);
    } catch (error) {
      log(`attempt ${attempt} failed, restarting from home:`, error.message.split('\n')[0]);
    }
  }
  return 'booking failed';
}

const isWeekendInOslo = () =>
  ['Sat', 'Sun'].includes(new Date().toLocaleDateString('en-US', { weekday: 'short', timeZone: timezone }));

const isBeforeOpeningInOslo = () =>
  Number(new Date().toLocaleString('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: timezone })) < 13;

async function runBookJob() {
  const forced = process.argv.includes('--force');
  if (isWeekendInOslo() && !forced) return log('weekend, skipping');
  if (isBeforeOpeningInOslo() && !forced) return log('before 13:00, skipping');
  log('bookIfNeeded started');
  const result = await withPage(bookIfNeeded).catch((error) => `failed: ${error.message.split('\n')[0]}`);
  log('bookIfNeeded result:', result);
  return result;
}

if (process.argv.includes('--run')) {
  await runBookJob();
  process.exit(0);
}

const task = cron.schedule('0 13-23 * * 1-5', async () => {
  await runBookJob();
  log('next scheduled try:', task.getNextRun()?.toLocaleString('nb-NO', { timeZone: timezone }));
}, { timezone });

log('scheduler started, next scheduled try:', task.getNextRun()?.toLocaleString('nb-NO', { timeZone: timezone }));
