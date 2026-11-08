## Steps

1. Wait til cron job should trigger start, make it start 13:00 each day
2. run auth flow, hit login, singiin
3. try book, if fails, do 3 retries
4. if not available to book, sleep for 60m then try again, and continue until next day 1300 or until you manage to book.
