import { chromium } from 'playwright';

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

const AVAILABILITY_URL = '/my-reservations/list-available';

async function openReservations(page) {
  await page.goto(PARKLY_URL);
  await enableSemantics(page);
  const availability = page.waitForResponse((response) => response.url().includes(AVAILABILITY_URL));
  await page.getByRole('button', { name: /^Reservations/ }).click();
  await page.getByRole('switch', { name: 'Show only available days' }).waitFor();
  await page.waitForLoadState('networkidle');
  const { dates } = await (await availability).json();
  return dates;
}

const osloDate = (offsetDays) =>
  new Date(Date.now() + offsetDays * 86400000).toLocaleDateString('sv-SE', { timeZone: timezone });

const firstService = (day) => day.services[0];

async function readReservationCount(page) {
  const text = await page.locator('flt-semantics[role=group]').first().innerText();
  return Number(text.match(/My reservations \((\d+)\)/)?.[1] ?? 0);
}

async function tryBook(page, cardIndex) {
  const count = await readReservationCount(page);
  await page.getByRole('button', { name: /Avtaleparkering/ }).nth(cardIndex).click();
  await page
    .locator('flt-semantics[role=group]', { hasText: `My reservations (${count + 1})` })
    .waitFor({ timeout: 10000 });
}

async function bookingFlow(page) {
  const dates = await openReservations(page);
  const targetDate = osloDate(1);
  const targetIndex = dates.findIndex((day) => day.date === targetDate);
  if (targetIndex === -1) return `${targetDate} not listed`;
  const { status, availableSpaces } = firstService(dates[targetIndex]);
  log(`${targetDate}: status=${status}, availableSpaces=${availableSpaces}`);
  if (status !== 'NoReservation' && status !== 'AtCapacity') return `already booked ${targetDate}`;
  if (availableSpaces < 1) return `not available ${targetDate}`;
  const cardIndex = dates.slice(0, targetIndex).filter((day) => firstService(day).availableSpaces > 0).length;
  await tryBook(page, cardIndex);
  return `booked ${targetDate}`;
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

const isTomorrowWeekendInOslo = () =>
  ['Sat', 'Sun'].includes(
    new Date(Date.now() + 86400000).toLocaleDateString('en-US', { weekday: 'short', timeZone: timezone }),
  );

const isBeforeOpeningInOslo = () =>
  Number(new Date().toLocaleString('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: timezone })) < 13;

async function runBookJob() {
  const forced = process.argv.includes('--force');
  if (isTomorrowWeekendInOslo() && !forced) return log('tomorrow is weekend, skipping');
  if (isBeforeOpeningInOslo() && !forced) return log('before 13:00, skipping');
  log('bookIfNeeded started');
  const result = await withPage(bookIfNeeded).catch((error) => `failed: ${error.message.split('\n')[0]}`);
  log('bookIfNeeded result:', result);
  return result;
}

await runBookJob();
