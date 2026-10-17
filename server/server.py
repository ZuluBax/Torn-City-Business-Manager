#!/usr/bin/env python3
"""
Torn company manager — home server (e.g. a Raspberry Pi).

Serves the web app and stores its data in one SQLite file so every device on the home
network sees the same data. Python standard library only: nothing to pip install.

The browser app still does all validation and money maths (js/services.js, js/calc.js);
this server is a small, careful document store:
  GET  /api/health                 -> {"ok": true}
  GET  /api/version                -> {"version": n}
  GET  /api/state                  -> every record + settings (Torn key withheld)
  POST /api/commit   {baseVersion, ops:[{store, put|del}]}  -> {"version": n}  (409 on conflict)
  POST /api/replace  {data, activity, clearSecrets}         -> {"version": n}
  GET  /api/torn/company           -> Torn API reply, fetched here with the stored key

Background thread: refreshes the Torn company snapshot and employees' working stats every
15 minutes and writes a daily backup.
"""
import argparse
import json
import logging
import mimetypes
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

RECORD_STORES = {"employees", "training", "payments", "expenses", "income", "activity", "tornEvents"}
ALL_STORES = RECORD_STORES | {"settings"}
SETTINGS_ID = "app"
SECRET_FIELD = "tornApiKey"
MAX_BODY = 20 * 1024 * 1024
STATIC_ROOTS = {"css", "js", "assets"}
TORN_URL = "https://api.torn.com/company/?selections=profile,employees,detailed,news&comment=TornCompanyManager&key="
TORN_REFRESH_SECONDS = 900  # also feeds the employees' "last active" timers, so hourly is too stale
TORN_EVENTS_URL = "https://api.torn.com/user/?selections=events&comment=TornCompanyManager&key="
TORN_EVENTS_SECONDS = 900  # Torn only returns the latest events, so poll often enough not to miss any
# Torn's 100/min limit is shared by every key on the account, so other tools can use it up.
# The window is one minute, so a single retry a minute later almost always gets through.
RATE_LIMIT_RETRY_SECONDS = 60
# Torn updates working stats once a day at 18:10 TCT (= UTC). One extra refresh a minute
# later gets them on screen promptly instead of up to 15 minutes late.
STATS_REFRESH_TCT = (18, 11)
BACKUPS_KEPT = 5  # one per day, so this is days of history; each file is ~80 KB

log = logging.getLogger("dukes")


class Store:
    """SQLite-backed document store mirroring the browser's IndexedDB object stores."""

    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS records (store TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (store, id));
            CREATE TABLE IF NOT EXISTS store_versions (store TEXT PRIMARY KEY, ver INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT OR IGNORE INTO meta VALUES ('version', '0');
        """)

    # -- helpers (call with self.lock held) --

    def _version(self) -> int:
        return int(self.db.execute("SELECT value FROM meta WHERE key='version'").fetchone()[0])

    def _bump(self, stores) -> int:
        v = self._version() + 1
        self.db.execute("UPDATE meta SET value=? WHERE key='version'", (str(v),))
        for s in stores:
            self.db.execute("INSERT INTO store_versions VALUES (?, ?) ON CONFLICT(store) DO UPDATE SET ver=excluded.ver", (s, v))
        return v

    def _settings(self) -> dict:
        row = self.db.execute("SELECT json FROM records WHERE store='settings' AND id=?", (SETTINGS_ID,)).fetchone()
        return json.loads(row[0]) if row else {}

    def _put_settings(self, incoming: dict, keep_secret: bool = True):
        current = self._settings()
        s = {k: v for k, v in incoming.items() if k != "tornApiKeySet"}
        # The browser never receives the key, so a settings save without it must keep it.
        if keep_secret and SECRET_FIELD not in s and current.get(SECRET_FIELD):
            s[SECRET_FIELD] = current[SECRET_FIELD]
        s["key"] = SETTINGS_ID
        self.db.execute("INSERT OR REPLACE INTO records VALUES ('settings', ?, ?)", (SETTINGS_ID, json.dumps(s)))

    # -- public API --

    def version(self) -> int:
        with self.lock:
            return self._version()

    def state(self) -> dict:
        with self.lock:
            out = {s: [] for s in RECORD_STORES}
            settings = {}
            for store, raw in self.db.execute("SELECT store, json FROM records"):
                if store == "settings":
                    settings = json.loads(raw)
                elif store in out:
                    out[store].append(json.loads(raw))
            has_key = bool(settings.pop(SECRET_FIELD, ""))
            settings["tornApiKeySet"] = has_key
            out["settings"] = settings
            out["version"] = self._version()
            return out

    def torn_key(self) -> str:
        with self.lock:
            return self._settings().get(SECRET_FIELD, "") or ""

    def commit(self, base_version, ops) -> int:
        with self.lock:
            touched = {op["store"] for op in ops}
            if base_version is not None:
                placeholders = ",".join("?" * len(touched))
                newest = self.db.execute(f"SELECT MAX(ver) FROM store_versions WHERE store IN ({placeholders})", tuple(touched)).fetchone()[0]
                if newest is not None and newest > base_version:
                    raise ConflictError()
            self.db.execute("BEGIN IMMEDIATE")
            try:
                for op in ops:
                    if op["store"] == "settings":
                        if "put" in op:
                            self._put_settings(op["put"])
                    elif "put" in op:
                        self.db.execute("INSERT OR REPLACE INTO records VALUES (?, ?, ?)", (op["store"], op["put"]["id"], json.dumps(op["put"])))
                    else:
                        self.db.execute("DELETE FROM records WHERE store=? AND id=?", (op["store"], op["del"]))
                v = self._bump(touched)
                self.db.execute("COMMIT")
                return v
            except Exception:
                self.db.execute("ROLLBACK")
                raise

    def replace(self, data: dict, activity, clear_secrets: bool) -> int:
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                current = self._settings()
                self.db.execute("DELETE FROM records")
                for store in RECORD_STORES:
                    for rec in data.get(store) or []:
                        self.db.execute("INSERT OR REPLACE INTO records VALUES (?, ?, ?)", (store, rec["id"], json.dumps(rec)))
                if activity:
                    self.db.execute("INSERT OR REPLACE INTO records VALUES ('activity', ?, ?)", (activity["id"], json.dumps(activity)))
                settings = dict(data.get("settings") or {})
                settings.pop(SECRET_FIELD, None)
                if not clear_secrets and current.get(SECRET_FIELD):
                    settings[SECRET_FIELD] = current[SECRET_FIELD]
                self._put_settings(settings, keep_secret=False)
                v = self._bump(ALL_STORES)
                self.db.execute("COMMIT")
                return v
            except Exception:
                self.db.execute("ROLLBACK")
                raise

    def update_settings_fields(self, fields: dict) -> int:
        with self.lock:
            s = self._settings()
            s.update(fields)
            self.db.execute("BEGIN IMMEDIATE")
            self._put_settings(s, keep_secret=False)
            v = self._bump({"settings"})
            self.db.execute("COMMIT")
            return v

    def add_torn_events(self, events: dict) -> int:
        """Store new "X sent you $N" events as status 'new'; the browser app decides what they mean."""
        with self.lock:
            rows = []
            for eid, ev in (events or {}).items():
                text = re.sub(r"<[^>]+>", "", str(ev.get("event", "")))
                if not re.search(r"\bsent you\b", text, re.I):
                    continue
                rid = f"tev-{eid}"
                if self.db.execute("SELECT 1 FROM records WHERE store='tornEvents' AND id=?", (rid,)).fetchone():
                    continue
                at = datetime.fromtimestamp(int(ev.get("timestamp", 0)), timezone.utc).isoformat().replace("+00:00", "Z")
                rows.append((rid, json.dumps({"id": rid, "at": at, "html": ev.get("event", ""), "status": "new",
                                              "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")})))
            if not rows:
                return 0
            self.db.execute("BEGIN IMMEDIATE")
            for rid, raw in rows:
                self.db.execute("INSERT INTO records VALUES ('tornEvents', ?, ?)", (rid, raw))
            self._bump({"tornEvents"})
            self.db.execute("COMMIT")
            return len(rows)

    def update_employee_stats(self, stats_by_torn_id: dict) -> int:
        """Overwrite workingStats for employees matched by Torn ID; returns how many changed.
        Only stats are touched: position, wage and joins/leaves still go through the import
        review in the browser, because those affect money."""
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        with self.lock:
            rows = []
            for rid, raw in self.db.execute("SELECT id, json FROM records WHERE store='employees'"):
                e = json.loads(raw)
                stats = stats_by_torn_id.get(str(e.get("tornId", "")))
                if e.get("isDemo") or e.get("status") == "left" or not stats or stats == e.get("workingStats"):
                    continue
                e["workingStats"], e["updatedAt"] = stats, now
                rows.append((rid, json.dumps(e)))
            if not rows:
                return 0  # no version bump, so open pages aren't told to reload for nothing
            self.db.execute("BEGIN IMMEDIATE")
            try:
                for rid, raw in rows:
                    self.db.execute("UPDATE records SET json=? WHERE store='employees' AND id=?", (raw, rid))
                self._bump({"employees"})
                self.db.execute("COMMIT")
            except Exception:
                self.db.execute("ROLLBACK")
                raise
            return len(rows)

    def backup(self, folder: Path) -> Path:
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / f"dukes-{date.today().isoformat()}.db"
        with self.lock:
            dest = sqlite3.connect(target)
            self.db.backup(dest)
            dest.close()
        for old in sorted(folder.glob("dukes-*.db"))[:-BACKUPS_KEPT]:
            old.unlink()
        return target


class ConflictError(Exception):
    pass


class BadRequest(Exception):
    pass


def validate_ops(ops):
    if not isinstance(ops, list) or not ops or len(ops) > 5000:
        raise BadRequest("ops must be a non-empty list")
    for op in ops:
        if not isinstance(op, dict) or op.get("store") not in ALL_STORES:
            raise BadRequest("unknown store")
        if "put" in op:
            rec = op["put"]
            if not isinstance(rec, dict):
                raise BadRequest("put must be an object")
            if op["store"] != "settings" and not (isinstance(rec.get("id"), str) and 0 < len(rec["id"]) <= 100):
                raise BadRequest("record id missing")
        elif "del" in op:
            if op["store"] == "settings" or not isinstance(op["del"], str):
                raise BadRequest("bad delete")
        else:
            raise BadRequest("op needs put or del")


class TornHTTPError(Exception):
    """Torn (or Cloudflare in front of it) answered, but with an HTTP error status."""
    def __init__(self, status: int):
        super().__init__(f"HTTP {status}")
        self.status = status


def fetch_torn(key: str, url: str = TORN_URL) -> bytes:
    if not key:
        return json.dumps({"error": {"code": 1, "error": "Key is empty"}}).encode()
    # Cloudflare in front of api.torn.com returns 403 to Python's default "Python-urllib"
    # user agent, so identify the app explicitly.
    req = urllib.request.Request(url + key, headers={"User-Agent": "TornCompanyManager/1.0 (self-hosted company tool)", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            return res.read()
    except urllib.error.HTTPError as e:  # must come before URLError: HTTPError is a subclass
        raise TornHTTPError(e.code) from None


def last_active_map(employees) -> dict:
    """Mirror of lastActiveMap() in js/torn.js: tornId -> {at: epoch ms, status}."""
    out = {}
    for torn_id, t in (employees or {}).items():
        la = t.get("last_action") if isinstance(t, dict) else None
        ts = la.get("timestamp") if isinstance(la, dict) else None
        if isinstance(ts, (int, float)) and not isinstance(ts, bool) and ts > 0:
            out[str(torn_id)] = {"at": int(ts * 1000), "status": str(la.get("status") or "Offline")}
    return out


def effectiveness_map(employees) -> dict:
    """Mirror of effectivenessMap() in js/torn.js: tornId -> {total, addiction}.
    Torn omits "addiction" when there is no penalty, so missing means 0."""
    def num(v):
        return isinstance(v, (int, float)) and not isinstance(v, bool)
    out = {}
    for torn_id, t in (employees or {}).items():
        eff = t.get("effectiveness") if isinstance(t, dict) else None
        if not isinstance(eff, dict) or not num(eff.get("total")):
            continue
        out[str(torn_id)] = {"total": eff["total"], "addiction": eff["addiction"] if num(eff.get("addiction")) else 0}
    return out


def _fmt_num(n) -> str:
    """Mirror of formatNumber() in js/util.js (en-US grouping, "—" for non-numbers)."""
    if isinstance(n, bool) or not isinstance(n, (int, float)) or n != n or n in (float("inf"), float("-inf")):
        return "—"
    return f"{int(n):,}" if n == int(n) else f"{n:,}"


def stats_text(t: dict) -> str:
    """Mirror of statsText() in js/torn.js — must produce identical text, or every refresh
    would look like a change."""
    return f"MAN {_fmt_num(t.get('manual_labor'))} / INT {_fmt_num(t.get('intelligence'))} / END {_fmt_num(t.get('endurance'))}"


def stats_map(employees) -> dict:
    """tornId -> stats text. Skips anyone Torn sent without stats rather than writing dashes."""
    out = {}
    for torn_id, t in (employees or {}).items():
        if isinstance(t, dict) and all(isinstance(t.get(k), (int, float)) and not isinstance(t.get(k), bool)
                                       for k in ("manual_labor", "intelligence", "endurance")):
            out[str(torn_id)] = stats_text(t)
    return out


def snapshot_from_torn(data: dict) -> dict:
    """Mirror of companySnapshot() in js/torn.js — keep the two in step."""
    c, d = data["company"], data["company_detailed"]
    return {
        "id": c.get("ID"), "name": c.get("name"), "rating": c.get("rating"),
        "employeesHired": c.get("employees_hired"), "employeesCapacity": c.get("employees_capacity"),
        "dailyIncome": c.get("daily_income"), "weeklyIncome": c.get("weekly_income"), "daysOld": c.get("days_old"),
        "funds": d.get("company_funds"), "trainsAvailable": d.get("trains_available"),
        "advertisingBudget": d.get("advertising_budget"), "popularity": d.get("popularity"),
        "efficiency": d.get("efficiency"), "environment": d.get("environment"),
        "lastActive": last_active_map(data.get("company_employees")),
        "effectiveness": effectiveness_map(data.get("company_employees")),
        "fetchedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def is_rate_limited(data=None, exc=None) -> bool:
    """Torn's own "too many requests" (code 5), or a plain HTTP 429 from Cloudflare."""
    if isinstance(exc, TornHTTPError):
        return exc.status == 429
    return isinstance(data, dict) and isinstance(data.get("error"), dict) and data["error"].get("code") == 5


def next_due(now: float, interval: float, rate_limited: bool, retried: bool):
    """-> (next attempt time, retried flag). Only one quick retry, so a busy account can't
    turn this into a tight loop; after that it falls back to the normal interval."""
    if rate_limited and not retried:
        return now + RATE_LIMIT_RETRY_SECONDS, True
    return now + interval, False


def next_daily_utc(now: float, hour: int, minute: int) -> float:
    """Epoch seconds of the next hour:minute UTC strictly after `now` (TCT is UTC)."""
    t = datetime.fromtimestamp(now, timezone.utc).replace(hour=hour, minute=minute, second=0, microsecond=0)
    if t.timestamp() <= now:
        t += timedelta(days=1)
    return t.timestamp()


def background_loop(store: Store, backup_dir: Path, stop: threading.Event):
    next_torn = next_events = 0.0
    retried_torn = retried_events = False
    next_stats = next_daily_utc(time.time(), *STATS_REFRESH_TCT)
    while not stop.is_set():
        if time.time() >= next_stats:
            next_torn = 0.0  # pull the company refresh forward; the normal 15-min cycle resumes after it
            next_stats = next_daily_utc(time.time(), *STATS_REFRESH_TCT)
            log.info("Daily stats refresh (Torn updates stats at 18:10 TCT)")
        if time.time() >= next_events:
            limited = False
            key = store.torn_key()
            if key:
                try:
                    data = json.loads(fetch_torn(key, TORN_EVENTS_URL))
                    if "error" in data:
                        limited = is_rate_limited(data)
                        log.warning("Torn events: API error code %s", data["error"].get("code"))
                    else:
                        n = store.add_torn_events(data.get("events"))
                        if n:
                            log.info("Torn events: %d new money event(s) stored", n)
                except Exception as e:
                    limited = is_rate_limited(exc=e)
                    log.warning("Torn events failed: %s", e if isinstance(e, TornHTTPError) else type(e).__name__)
            next_events, retried_events = next_due(time.time(), TORN_EVENTS_SECONDS, limited, retried_events)
            if retried_events:
                log.info("Torn events: rate limited, retrying in %ds", RATE_LIMIT_RETRY_SECONDS)
        try:
            if not (backup_dir / f"dukes-{date.today().isoformat()}.db").exists():
                log.info("daily backup written: %s", store.backup(backup_dir).name)
        except Exception:
            log.exception("backup failed")
        if time.time() >= next_torn:
            limited = False
            key = store.torn_key()
            if key:
                try:
                    data = json.loads(fetch_torn(key))
                    if "error" in data:
                        limited = is_rate_limited(data)
                        log.warning("Torn refresh: API error code %s", data["error"].get("code"))
                    else:
                        store.update_settings_fields({"tornCompany": snapshot_from_torn(data)})
                        changed = store.update_employee_stats(stats_map(data.get("company_employees")))
                        log.info("Torn company figures refreshed%s", f"; stats updated for {changed} employee(s)" if changed else "")
                except Exception as e:  # network blips are expected; try again next round
                    limited = is_rate_limited(exc=e)
                    log.warning("Torn refresh failed: %s", e if isinstance(e, TornHTTPError) else type(e).__name__)
            next_torn, retried_torn = next_due(time.time(), TORN_REFRESH_SECONDS, limited, retried_torn)
            if retried_torn:
                log.info("Torn refresh: rate limited, retrying in %ds", RATE_LIMIT_RETRY_SECONDS)
        # Wake for whichever is due first (a retry may be due in under 5 minutes).
        stop.wait(max(1, min(300, min(next_torn, next_events, next_stats) - time.time())))


def make_handler(store: Store, app_dir: Path):
    app_dir = app_dir.resolve()

    class Handler(BaseHTTPRequestHandler):
        server_version = "DukesMusicBox/1"

        def log_message(self, fmt, *args):
            # Only log failed requests (args = requestline, status, size). Never logs bodies.
            if len(args) > 1 and str(args[1])[:1] in ("4", "5"):
                # An https:// attempt on this plain-http port arrives as binary TLS bytes;
                # keep the log readable instead of dumping them.
                msg = (fmt % args).encode("ascii", "replace").decode()[:200]
                if not msg.isprintable():
                    msg = "non-HTTP request (probably https:// on the http port)"
                log.info("%s %s", self.address_string(), msg)

        def _send(self, status, body=b"", ctype="application/json", extra=None):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Content-Type-Options", "nosniff")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, status, obj):
            self._send(status, json.dumps(obj).encode())

        def _body(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY:
                raise BadRequest("body missing or too large")
            try:
                return json.loads(self.rfile.read(length))
            except json.JSONDecodeError:
                raise BadRequest("invalid JSON")

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            try:
                if path == "/api/health":
                    return self._json(200, {"ok": True})
                if path == "/api/version":
                    return self._json(200, {"version": store.version()})
                if path == "/api/state":
                    return self._json(200, store.state())
                if path == "/api/torn/company":
                    try:
                        return self._send(200, fetch_torn(store.torn_key()))
                    except TornHTTPError as e:
                        log.warning("Torn import: Torn answered HTTP %s", e.status)
                        return self._json(503, {"error": f"Torn refused the request (HTTP {e.status}). Try again in a few minutes."})
                    except (urllib.error.URLError, TimeoutError, OSError) as e:
                        log.warning("Torn import: network error %s", type(e).__name__)
                        return self._json(502, {"error": "Could not reach Torn from the Pi."})
                return self._static(path)
            except Exception:
                log.exception("GET %s failed", path)
                return self._json(500, {"error": "Server error"})

        do_HEAD = do_GET

        def do_POST(self):
            path = self.path.split("?", 1)[0]
            try:
                body = self._body()
                if path == "/api/commit":
                    validate_ops(body.get("ops"))
                    base = body.get("baseVersion")
                    if base is not None and not isinstance(base, int):
                        raise BadRequest("bad baseVersion")
                    return self._json(200, {"version": store.commit(base, body["ops"])})
                if path == "/api/replace":
                    data = body.get("data")
                    if not isinstance(data, dict):
                        raise BadRequest("data missing")
                    for s in RECORD_STORES:
                        recs = data.get(s) or []
                        if not isinstance(recs, list) or any(not isinstance(r, dict) or not isinstance(r.get("id"), str) for r in recs):
                            raise BadRequest(f"bad records in {s}")
                    act = body.get("activity")
                    if act is not None and not (isinstance(act, dict) and isinstance(act.get("id"), str)):
                        raise BadRequest("bad activity")
                    return self._json(200, {"version": store.replace(data, act, bool(body.get("clearSecrets")))})
                return self._json(404, {"error": "Not found"})
            except ConflictError:
                return self._json(409, {"error": "Data was changed on another device."})
            except BadRequest as e:
                return self._json(400, {"error": str(e)})
            except Exception:
                log.exception("POST %s failed", path)
                return self._json(500, {"error": "Server error"})

        def _static(self, path):
            if path in ("/", "/index.html"):
                target = app_dir / "index.html"
            else:
                parts = [p for p in path.split("/") if p]
                if not parts or parts[0] not in STATIC_ROOTS or any(p in ("..", ".") or p.startswith(".") for p in parts):
                    return self._json(404, {"error": "Not found"})
                target = (app_dir.joinpath(*parts)).resolve()
                if app_dir not in target.parents or not target.is_file():
                    return self._json(404, {"error": "Not found"})
            if not target.is_file():
                return self._json(404, {"error": "Not found"})
            ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml"):
                ctype += "; charset=utf-8"
            return self._send(200, target.read_bytes(), ctype)

    return Handler


def main():
    here = Path(__file__).resolve().parent
    p = argparse.ArgumentParser(description="Torn company manager home server")
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=8010)
    p.add_argument("--app-dir", type=Path, default=here.parent, help="folder containing index.html")
    p.add_argument("--data-dir", type=Path, default=Path.home() / "dukes-music-box" / "data")
    p.add_argument("--backup-dir", type=Path, default=Path.home() / "dukes-music-box" / "backups")
    p.add_argument("--no-background", action="store_true", help="disable background Torn refresh and daily backups (tests)")
    args = p.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("image/svg+xml", ".svg")

    store = Store(args.data_dir / "dukes.db")
    stop = threading.Event()
    if not args.no_background:
        threading.Thread(target=background_loop, args=(store, args.backup_dir, stop), daemon=True).start()

    httpd = ThreadingHTTPServer((args.host, args.port), make_handler(store, args.app_dir))
    log.info("Company manager serving %s on http://%s:%d (data: %s)", args.app_dir, args.host, args.port, args.data_dir)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        httpd.server_close()


if __name__ == "__main__":
    main()
