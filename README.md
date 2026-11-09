# parkly-booker

Books tomorrow's Parkly "Avtaleparkering" spot.

## Flow

1. cron-job.org calls the GitHub API at ~12:50 Oslo → triggers the `Book parking` workflow.
2. Workflow runs `node index.js`.
3. Skips if today or tomorrow is Sat/Sun or it's more than 15 min before 13:00 (Oslo).
4. Logs in, waits until 13:00 → Reservations → reads tomorrow's status from the availability API.
5. Already booked → done. Full → done, next trigger tries again. Available → clicks it.
6. Any failure (incl. tomorrow not listed yet) → restart from Home; 6 retries: 2 fast (0.5s), then 2s/4s/8s/16s.

## Commands

- `just book` — run locally, ignoring weekend/13:00 rules
- `just gh-book` — trigger a forced run on GitHub and watch it
- `just gh-logs` — latest GitHub run logs

## Setup

- `.env` / repo secrets: `PARKLY_URL`, `PARKLY_EMAIL`, `PARKLY_PASSWORD`
- cron-job.org: `POST https://api.github.com/repos/Amund-Fremming/parkly-booking-cron/actions/workflows/book.yml/dispatches`, body `{"ref":"main"}`, headers `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `User-Agent: parkly-booker`. Token: fine-grained, this repo only, Actions read/write.
