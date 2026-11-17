# TODO

## Where we left off (17 Nov 2026)

**Sold the Music Store; now running an Adult Novelties company.** The app now works for any
of Torn's 39 company types (branch `any-company-type`):
- Job tables come from Torn (`torn?selections=companies`) on Import, saved as
  `settings.companyType`. No company's jobs are hard-coded any more.
- The Pi snapshot records `typeId`; the Dashboard says when the type doesn't match the saved
  table. Importing a new type swaps positions, resets limits and clears dead chosen jobs.
- Music-note logo and training icon replaced (briefcase, dumbbell).
- Checked on a throwaway copy on the Pi (port 8011, copy of the real data) before deploying.

Data: the live app was already reset and set up for the new company on 17 Nov (9 staff
imported). **The Music Store's full history** (23 staff, 24 trainings, 13 payments, 31 days of
logs) is kept outside the 5-day backup rotation at
`~/torn-company-manager/archive/music-store-final-2026-11-17.db` on the Pi, plus a copy in
`backups/` on the PC (git-ignored).

Facts learned:
- Torn API keys belong to the **player**, not the company: the same key follows you to a
  new company.
- Torn job tables: every job needs exactly two stats; 34 of 39 types have two jobs with
  the same main requirement (hence the tie-break in `byDifficulty`).
- The Pi log shows Torn "code 5" (too many requests) on events polls: the 100/min limit is
  shared by every key on the account, so another tool using it can starve this one.

## Earlier (5 Nov 2026)

Everything is committed, pushed to GitHub and deployed to the Pi. Nothing is half-finished.

Shipped today:
- **Sales & customers panel** on the dashboard: daily and weekly figures from Torn, plus this
  month, the last 7 days and totals by month from the daily log. The log now also saves
  `dailyCustomers`.
- **Chosen job picker:** for anyone whose stats meet 2+ jobs. It counts toward job limits, a
  stale pick falls back to automatic with a warning, and a move on Torn clears it.
- **Employees count** now shows current staff only and says how many who left are hidden.
- **Delete training from the employee profile** (removes the trains, the money owed and any
  linked payment).
- **Renamed away from the old business name** everywhere, the Pi included: folder and service
  `torn-company-manager`, files `company.db` / `company-YYYY-MM-DD.db`. The safety copy has
  been deleted. Rule: no real business name in the repo. Use "Your Business Name Here" in
  examples.

Facts to remember:
- Torn's `daily_income` / `daily_customers` are for **yesterday's full day**, not today so
  far.
- Torn's daily effectiveness/addiction update is at about 18:09 TCT, and the Pi re-reads at
  18:11.
- Torn parsing exists twice: `js/torn.js` (browser) and `server/server.py` (Pi). Change both.
  This PC has no Python, so check `server.py` on the Pi over SSH.

## Next up

1. **Addiction vs income.** The daily log restarted with the new company on 17 Nov, so wait
   until it has a few weeks (about mid-December), then compare addiction against daily sales.

## Shipped 13 Nov 2026

- **Role advisor** (Employees page + Dashboard box): best fit, also-meets, closest two and
  suggested moves per role. Deployed to the Pi. Phone-width layout not checked yet.
- **Employees status filter:** "All statuses" removed; staff who left only show under "Left".

## Ideas (not started)

- **Company stock and specials** from Torn (same `companies` data: stock cost/RRP, special
  abilities by star rating). Could show margins per item.
- **Several companies in one app**, if you ever run two at once. Today: one company per copy.

- **Role advisor: weigh effectiveness/addiction** alongside stats, once there's enough log.

- **Record actual salary payments** to compare against the estimate.
- **Employment periods** for people who leave and come back. Today one start date covers it
  all.
- **Reminder to back up** the double-click copy (the Pi backs itself up daily).
- **Payment reminders** / Discord messages for people who owe money.
- **Sales charts:** a line chart of daily sales and customers over time.
- **Employee performance scoring** and automatic monthly reports.

## Done (older)

- Multi-device access: solved by the Pi server (`server/server.py`) rather than a hosted
  backend.
- Automatic train payments from Torn "sent you $" messages.
- Effectiveness and addiction tracking with a daily log (since 17 Oct 2026).
- Job fit, job suggestions and per-job limits.
