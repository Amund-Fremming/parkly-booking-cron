import { chromium } from 'playwright';

const { PARKLY_URL, PARKLY_EMAIL, PARKLY_PASSWORD } = process.env;
const BURST_DELAYS_MS = [0, 0, 0, 1000, 1000, 1000];
const CONFIRM_TIMEOUT_MS = 1000;
const BACKOFF_START_MS = 30000;
const BACKOFF_MAX_MS = 10 * 60000;
const POLL_WINDOW_MS = 5.5 * 3600000;
const EARLY_START_MS = 15 * 60000;
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
    .waitFor({ timeout: CONFIRM_TIMEOUT_MS });
}

async function bookingFlow(page) {
  const dates = await openReservations(page);
  const targetDate = osloDate(1);
  const targetIndex = dates.findIndex((day) => day.date === targetDate);
  if (targetIndex === -1) throw new Error(`${targetDate} not listed`);
  const { status, availableSpaces } = firstService(dates[targetIndex]);
  log(`${targetDate}: status=${status}, availableSpaces=${availableSpaces}`);
  if (status !== 'NoReservation' && status !== 'AtCapacity') return `already booked ${targetDate}`;
  if (availableSpaces < 1) return `not available ${targetDate}`;
  const cardIndex = dates.slice(0, targetIndex).filter((day) => firstService(day).availableSpaces > 0).length;
  await tryBook(page, cardIndex);
  return `booked ${targetDate}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function msUntilOpeningInOslo() {
  const now = new Date();
  const [hours, minutes, seconds] = now
    .toLocaleTimeString('en-GB', { hour12: false, timeZone: timezone })
    .split(':')
    .map(Number);
  return ((13 * 60 - hours * 60 - minutes) * 60 - seconds) * 1000 - now.getMilliseconds();
}

const isDone = (result) => result.startsWith('booked') || result.startsWith('already booked');

const failed = (error) => `failed: ${error.message.split('\n')[0]}`;

async function bookWithRetries(page) {
  let result = 'booking failed';
  for (const [index, delay] of BURST_DELAYS_MS.entries()) {
    await sleep(delay);
    const attempt = index + 1;
    log(`booking attempt ${attempt}/${BURST_DELAYS_MS.length}`);
    result = await bookingFlow(page).catch(failed);
    if (isDone(result)) return result;
    log(`attempt ${attempt}: ${result}`);
  }
  return result;
}

async function pollUntilBooked(deadline) {
  let result = 'booking failed';
  for (let delay = BACKOFF_START_MS; Date.now() + delay < deadline; delay = Math.min(delay * 2, BACKOFF_MAX_MS)) {
    log(`retrying in ${delay / 1000}s`);
    await sleep(delay);
    result = await withPage(bookingFlow).catch(failed);
    log('poll result:', result);
    if (isDone(result)) return result;
  }
  return result;
}

const bookIfNeeded = (waitMs) => async (page) => {
  log(`logged in, waiting ${Math.round(waitMs / 1000)}s until 13:00`);
  await sleep(waitMs);
  return bookWithRetries(page);
};

const isWeekendInOslo = (offsetDays) =>
  ['Sat', 'Sun'].includes(
    new Date(Date.now() + offsetDays * 86400000).toLocaleDateString('en-US', { weekday: 'short', timeZone: timezone }),
  );

async function runBookJob() {
  const forced = process.argv.includes('--force');
  if (isWeekendInOslo(0) && !forced) return log('today is weekend, skipping');
  if (isWeekendInOslo(1) && !forced) return log('tomorrow is weekend, skipping');
  const waitMs = forced ? 0 : Math.max(0, msUntilOpeningInOslo());
  if (waitMs > EARLY_START_MS) return log('more than 15 min before 13:00, skipping');
  log('bookIfNeeded started');
  const result = await withPage(bookIfNeeded(waitMs)).catch(failed);
  log('bookIfNeeded result:', result);
  if (isDone(result) || forced) return result;
  const finalResult = await pollUntilBooked(Date.now() + POLL_WINDOW_MS);
  log('final result:', finalResult);
  return finalResult;
}

await runBookJob();
