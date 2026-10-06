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

Background thread: refreshes the Torn company snapshot hourly and writes a daily backup.
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
from datetime import date, datetime, timezone
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
TORN_REFRESH_SECONDS = 3600
TORN_EVENTS_URL = "https://api.torn.com/user/?selections=events&comment=TornCompanyManager&key="
TORN_EVENTS_SECONDS = 900  # Torn only returns the latest events, so poll often enough not to miss any
BACKUPS_KEPT = 30

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
        "fetchedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def background_loop(store: Store, backup_dir: Path, stop: threading.Event):
    last_torn = 0.0
    last_events = 0.0
    while not stop.is_set():
        if time.time() - last_events >= TORN_EVENTS_SECONDS:
            last_events = time.time()
            key = store.torn_key()
            if key:
                try:
                    data = json.loads(fetch_torn(key, TORN_EVENTS_URL))
                    if "error" in data:
                        log.warning("Torn events: API error code %s", data["error"].get("code"))
                    else:
                        n = store.add_torn_events(data.get("events"))
                        if n:
                            log.info("Torn events: %d new money event(s) stored", n)
                except Exception as e:
                    log.warning("Torn events failed: %s", type(e).__name__)
        try:
            if not (backup_dir / f"dukes-{date.today().isoformat()}.db").exists():
                log.info("daily backup written: %s", store.backup(backup_dir).name)
        except Exception:
            log.exception("backup failed")
        if time.time() - last_torn >= TORN_REFRESH_SECONDS:
            last_torn = time.time()
            key = store.torn_key()
            if key:
                try:
                    data = json.loads(fetch_torn(key))
                    if "error" in data:
                        log.warning("Torn refresh: API error code %s", data["error"].get("code"))
                    else:
                        store.update_settings_fields({"tornCompany": snapshot_from_torn(data)})
                        log.info("Torn company figures refreshed")
                except Exception as e:  # network blips are expected; try again next hour
                    log.warning("Torn refresh failed: %s", type(e).__name__)
        stop.wait(300)


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
    p.add_argument("--no-background", action="store_true", help="disable hourly Torn refresh and daily backups (tests)")
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
