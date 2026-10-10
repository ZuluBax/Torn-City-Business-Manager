# Torn Company Manager

A self-hosted management app for a company in Torn City. It tracks employees, salaries,
training ("trains"), payments, other income and expenses, and profit. It's built for
running a Music Store, but works for any company type.

- **Works offline:** open `index.html` and data is saved in your browser.
- **Or run it on a home server** (for example a Raspberry Pi) so every device shares one copy.
- **Optional Torn API** (Limited Access key): import employees and company figures, and
  record train payments automatically from "sent you $" messages.
- **No accounts, no analytics.** Your data and key never leave your machines, except for
  calls to `api.torn.com`.

Set your company name, train price and dashboard banner in **Settings**.

---

## Running it

1. Open the project folder.
2. Double-click **`index.html`**. It opens in your default browser. That's it.

Use the **same browser** every time (Chrome or Edge is best). Each browser keeps its own
separate copy of the data.

**Optional: run it as a local website.** If double-clicking ever gives you trouble, run
this from the `DMS` folder and open http://localhost:8080:

```powershell
npx --yes http-server -p 8080 -c-1
```

> ⚠️ The data is tied to the address you open. Data saved under `file:///…/index.html` will
> **not** appear under `http://localhost:8080`, and the other way round. Pick one way and
> stick with it, or move the data across with Export → Import.

### Running the tests

```powershell
node --test tests/*.test.js
```

These tests cover the money maths: balances, part payments, refunds, overpayment blocking,
salary changes, profit and date ranges.

---

## Running on a Raspberry Pi / home server (always on, shared by every device)

**Setup:** copy `deploy/pi.env.example` to `deploy/pi.env` and set `PI=user@your-pi.local`.
This file is git-ignored, so your address stays private. You need SSH key login and
passwordless `sudo` on the Pi, plus `python3` and `curl`. Then run `./deploy/deploy.sh` and
open `http://your-pi.local:8010` on any device on your network.

When the app is opened from the Pi, it stores data **on the Pi** (SQLite at
`~/dukes-music-box/data/dukes.db`) instead of in the browser. Your PC, phone and tablet
then all see the same data. Opening `index.html` by double-click still works as before,
but that copy keeps its own separate browser data.

| What | Detail |
|---|---|
| Server | `server/server.py`. Uses only Python's standard library, so nothing to install. Runs as the systemd service `dukes-music-box` (the internal name, kept for compatibility) as your SSH user, on port 8010. It starts on boot and restarts if it crashes. |
| Backups | A copy is saved to `~/dukes-music-box/backups/dukes-YYYY-MM-DD.db` every day, and the last 5 are kept (older ones are deleted automatically). |
| Torn | The Pi holds the API key (browsers only see "a key is set"). It refreshes company funds, trains available, each employee's "last active" time and their working stats every 15 minutes, plus an extra refresh at 18:11 TCT because Torn updates stats daily at 18:10. Position, wage and joins/leaves still need the import button, because they affect money. If Torn says "too many requests", it retries once a minute later. |
| Several devices | Other devices pick up changes within about 15 seconds. If two devices edit at once, the later save is refused and the page refreshes, so nothing is overwritten by accident. |
| Security | Home network only, with no login. Anyone on your Wi-Fi can open it. **Don't port-forward it.** For access away from home, use Tailscale. |

**Deploy an update** (from Git Bash in the DMS folder):

```bash
./deploy/deploy.sh             # runs the tests, uploads, restarts, health-checks (rolls back automatically if unhealthy)
./deploy/deploy.sh --rollback  # put the previous version back
./deploy/deploy.sh --status    # service status, recent logs, latest backups
```

Deploys only replace `~/dukes-music-box/app`. The `data/` and `backups/` folders are never
touched.

**Restore a nightly backup on the Pi:**
`sudo systemctl stop dukes-music-box`, then copy the backup file over
`~/dukes-music-box/data/dukes.db`, delete `dukes.db-wal` and `dukes.db-shm` if they exist,
then `sudo systemctl start dukes-music-box`.

**Move data from a browser to the Pi:** in the old copy, go to Settings → Export backup.
Then open the Pi address and go to Settings → Import backup.

## Import from Torn (optional, needs internet)

1. In Torn, go to Settings → API Keys and create a **Limited Access** key. You must be the company director.
2. In the app, go to **Settings → Torn API**, paste the key and press **Save key**.
3. Press **Import from Torn**. It's on Settings, Employees and the Dashboard. You'll get a **preview**, and
   nothing is saved until you tick items and press Import.

What it can bring in:
- **New employees:** name, Torn ID, position, daily wage, working stats. The start date is worked
  out as today minus their days in the company.
- **Changes** to existing staff (matched by Torn ID): a new position, a new wage (recorded as a
  salary change from today), updated stats, or someone being back in the company.
- **Staff no longer in your Torn company.** These are offered as "mark as Left" and are unticked
  by default.
- **Money already spent, once only:** deposits − withdrawals − funds left. This is only offered
  while the company has had no income and Torn's news still goes back to the day it was
  founded. Otherwise the sum would be wrong, so it isn't shown.
- **Company figures** (funds, trains available, staff, daily income) are shown on the Dashboard
  and Training page. They only change when you import again.

### Automatic train payments from Torn messages

When an employee sends you money in Torn with a message like **`train 1`**, the app can
record it for you. The Pi checks your Torn events every 15 minutes. A double-clicked copy
checks while it's open.

| Situation | What happens |
|---|---|
| The sender is an employee, the message has a train count, the amount = trains × current price, and they **owe** that much | The payment is recorded against their oldest unpaid training |
| Same as above, but they **owe nothing** | A paid training record **and** its payment are recorded together |
| An employee sent money, but the amount doesn't match, there's no train count, or it's more than they owe | It goes to **Payments → Payments to check**, with buttons for *Training + payment*, *Payment only* or *Dismiss* |
| The sender isn't an employee, or it's a faction gift ("gave $X to you from …") | Ignored |

Each Torn event is used **once**. Its id is stored in the `tornEvents` list, so reloading
the page or having several devices open never adds a payment twice. Train counts are read
from phrasings like `train 1`, `train x2`, `2 trains` and `trains: 3`.

> The "sent you" wording is matched loosely, because the exact Torn text wasn't confirmed
> when this was written. If a real payment shows up in *Payments to check* with "Could not
> read this message", the parser in `js/torn.js` (`parseMoneyEvent`) needs adjusting.

Things it does **not** do: it doesn't import what you paid to start the company. Enter that
yourself.

The key is stored only in this browser. It is never included in backup files, and it is
kept when you import a backup. The app only talks to `api.torn.com` when you press the
button. The import logic is in `js/torn.js` (`buildPlan` is pure and has unit tests).

## Back up your data (important)

Your data lives **only in this browser's storage**. It is lost if you clear browsing data,
reset the browser, or use a private/incognito window.

- **Settings → Export backup** downloads `dukes-music-box-backup-YYYY-MM-DD.json` to your
  Downloads folder. Copy it somewhere safe. The `backups/` folder here is a good place
  (the browser can't save there by itself).
- **Settings → Import backup** checks the file, shows what's in it, asks you to confirm,
  then **replaces everything** with the backup.
- **Settings → Reset all data** deletes everything. You must type `RESET` to confirm.

Before importing, the file is checked carefully. It must be one of this app's backups,
every record must have an id, all links between records must be valid, and every
employee's balance must add up. A broken file is rejected and your current data is left
untouched.

Each backup has a `backupVersion` number (currently `1`). If a future version of the app
changes the format, `migrate()` in `js/backup.js` upgrades old backups before importing.

---

## How the money works

| Thing | Rule |
|---|---|
| Training charge | `trains × price per train`. The price is saved on each record, so changing the default price in Settings never changes old records. |
| Free / Director trains | Default price is $0, so they cost nothing and are never outstanding. You can type a price to override this. |
| Paying when you record training | Pick *Paid in full* or *Part paid*. The app creates a matching payment record linked to that training. |
| Balances | Never typed in. They are always worked out as **charges − payments**. |
| Payments linked to a training record | Count against that record only. |
| Payments not linked | Pay off the **oldest** unpaid training first. |
| Refunds | Reduce what has been paid (newest records first if not linked). |
| "Other" payments | Counted as other income. They don't change training balances. |
| Overpaying | Blocked. A payment can't be more than is owed. Editing or deleting records that would cause an overpayment is also blocked. |
| Salary cost (estimate) | Salary per day × days employed. Both the start and end days count. If someone's pay changed, each day uses the rate that applied on that day. Inactive staff still count until they get an end date. This does **not** copy Torn's exact payout rules. |
| Training revenue | Counted when training is **recorded**, paid or not. "Cash collected" and "Outstanding" are shown next to it, so unpaid money is never hidden. |
| Net profit | Total income − total expenses. |

---

## Features (Version 1)

- **Dashboard:** 8 summary cards, financial and training summaries, who owes money (with a
  quick "Pay" button), employee overview and recent activity.
- **Employees:** add, edit, search (by name or Torn ID), filter by status or position, and
  sort by name, salary, start date or amount owed. Duplicate Torn IDs are blocked. Mark
  someone as *Left* (history is kept) or re-activate them. You can only permanently delete
  an employee who has no history.
- **Employee profile:** details, money summary, net value to the company, and history of
  training, payments and salary changes. Quick actions are on the profile too.
- **Training:** summary cards, a record form with a live total, upfront payment, filters
  (employee, dates, payment status, train type) and a totals row.
- **Payments:** record train payments, other payments and refunds. You can link a payment to
  one training record, and the form shows the balance before and after. Filters and totals
  are included.
- **Finances:** pick a date range to see income, expenses and profit. There's a month-by-month
  chart, salary estimates (daily, weekly, monthly, all time), and other income and expense
  entries.
- **Reports:** training revenue, employee salary, outstanding payments (as of any date),
  profit by month and employee training. Filter by date, employee or category, then
  **export to CSV** or **print**.
- **Settings:** company name, currency, default train price, positions, expense and income
  categories, a dark or light theme, backup and restore, demo data, and reset.
- **Other:** clear error messages next to each form field (no pop-up alerts), and safe
  confirmation dialogs before anything destructive. Money can be typed in Torn shorthand
  (`420k`, `1.5m`). It works on desktop, tablet and phone (the menu collapses and wide
  tables scroll), and prints cleanly. No analytics, nothing is sent anywhere, and all icons
  and charts are built in.

**Demo data:** Settings → *Load demo data* adds records labelled `[DEMO]`. *Remove demo data*
deletes only those records.

---

## Project structure

```
index.html            App shell and the order scripts load in
css/styles.css        All styling. Colours are CSS variables; light theme via [data-theme]
js/util.js            Dates, money formatting and parsing, escaping (pure, no DOM)
js/torn.js            Torn API fetch + import plan (preview before saving)
js/calc.js            ALL financial maths: ledger, salary, summaries (pure, unit-tested)
js/jobs.js            Music Store job fit + suggestions: stats vs. each job's recommended stats (Torn wiki), job limits from Settings; the strongest person gets a limited job (pure, unit-tested)
js/db.js              IndexedDB storage with an in-memory copy and atomic multi-record saves
js/services.js        Business rules: validation, data rules, activity log. The only writer.
js/ui.js              Shared UI pieces: modal, confirm, toast, tables, badges, icons, filters
js/forms.js           Employee, training, payment and income/expense forms (used on many pages)
js/backup.js          Export, import (with validation and migration hook), demo data, reset
js/views/*.js         One file per page
js/app.js             Start-up, hash router (#/employees/<id>), re-draws when data changes
tests/calc.test.js    Node unit tests for calc.js and util.js
tests/jobs.test.js    Node unit tests for jobs.js
backups/              Somewhere to keep exported backup files
```

**Why plain scripts and not ES modules?** Browsers block modules on pages opened straight
from disk (`file://`). Plain scripts sharing one `window.DMB` namespace let the app open
with a double-click.

**Data flow:** view → `services` (checks the input) → `db.commit` (saves everything in one
go, or nothing) → change event → the page re-draws using `calc` on the saved data.

---

## Data model (IndexedDB database `dukes-music-box`)

Every record has a random `id`, plus `createdAt` and `updatedAt` timestamps. Dates are
stored as `YYYY-MM-DD` text. Money is stored in whole dollars. Records point to each
other by **id**, never by name. Demo records also have `isDemo: true`.

| Store | Fields |
|---|---|
| `employees` | `name, tornId, position, status (active/inactive/left), startDate, endDate, reasonForLeaving, workingStats, notes, salaryHistory[{effectiveFrom, salaryPerDay}]` |
| `training` | `employeeId, date, trainCount, trainType (paid/free/director/other), pricePerTrain, totalAmount, notes` |
| `payments` | `employeeId, trainingId (optional), date, amount, paymentType (train/other/refund), notes` |
| `expenses` | `date, category, description, amount, notes` |
| `income` | `date, category, description, amount, notes` |
| `settings` | One record (`key: 'app'`): `companyName, currency, trainPrice, positions[], expenseCategories[], incomeCategories[], theme` |
| `activity` | `at, type, message`. Only the newest 300 are kept. |

A note on two choices that differ from the original spec:
- **No `salaryPerDay` field on employees.** The app keeps `salaryHistory` instead, so a pay
  rise doesn't change past salary costs. The current salary is the latest entry.
- **No stored "payment status" on training.** Paid, Partial, Unpaid and Free are always
  worked out from the payments, so they can't get out of sync.
- `totalAmount` on training is saved only so it shows up in exports. The app always works it
  out again.

---

## Known limits

- One period of employment per person. If someone leaves and is re-activated, the salary
  estimate counts the time they were away. Edit their start date if that matters.
- Statuses are fixed (Active, Inactive, Left) because the maths depends on them.
- Salary is an estimate, not actual Torn payouts.
- Data is saved per browser and per address (see "Running it").

## Ideas for Version 2

1. **Record actual salary payments** to compare against the estimate.
2. **Employment periods** to handle people who leave and come back.
3. **Reminder to back up** (for example, a banner if the last export was more than 7 days ago).
4. **More Torn data:** trains given and payments received, if Torn exposes them reliably. This needs an API key
   and online access, so it would be opt-in.
5. **Payment reminders** and Discord notifications for people who owe money.
6. **Multi-device access:** a small hosted backend (for example Supabase or Cloudflare D1)
   with login, replacing `db.js` behind the same interface.
7. **Employee performance scoring**, automatic monthly reports, and richer profit analytics.
