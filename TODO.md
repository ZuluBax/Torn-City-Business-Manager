# TODO

## Where we left off (5 Nov 2026)

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

1. **Check the new screens in a browser.** The Sales panel and chosen-job dropdowns were
   used once live (5 Nov) but haven't been fully looked over.
2. **Addiction vs income.** Once the daily log has a few more weeks (from about early
   December), compare employees' addiction against daily sales.

## Ideas (not started)

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
