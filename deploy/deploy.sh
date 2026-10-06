#!/usr/bin/env bash
# Deploy the app to a Linux box (e.g. a Raspberry Pi) over SSH.   Run from Git Bash / a shell
# in the project folder:
#   ./deploy/deploy.sh             copy the app, restart, check it's healthy (auto-rollback if not)
#   ./deploy/deploy.sh --rollback  put the previous version back
#   ./deploy/deploy.sh --status    show service status and recent log lines
#
# Settings come from deploy/pi.env (git-ignored, so your address stays private):
#   PI=user@your-pi.local
#   PORT=8010
# Needs: SSH key login to PI, passwordless sudo there, python3 and curl on the Pi.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f deploy/pi.env ]; then set -a; . deploy/pi.env; set +a; fi
: "${PI:?Set PI=user@host in deploy/pi.env (see deploy/pi.env.example)}"
PORT="${PORT:-8010}"
SERVICE=dukes-music-box
PI_USER="${PI%%@*}"
PI_HOST="${PI#*@}"

remote() { ssh -o BatchMode=yes "$PI" "$@"; }

PI_HOME="$(remote 'printf %s "$HOME"')"
BASE="$PI_HOME/dukes-music-box"

health() {
  remote "for i in 1 2 3 4 5 6 7 8 9 10; do curl -fsS -m 2 http://127.0.0.1:$PORT/api/health >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1"
}

case "${1:-}" in
  --status)
    remote "systemctl --no-pager status $SERVICE | head -5; echo; journalctl -u $SERVICE -n 15 --no-pager; echo; ls -1 $BASE/backups | tail -5"
    exit 0 ;;
  --rollback)
    remote "test -d $BASE/app.prev || { echo 'No previous version to roll back to.'; exit 1; }
            rm -rf $BASE/app.failed && mv $BASE/app $BASE/app.failed && mv $BASE/app.prev $BASE/app && sudo systemctl restart $SERVICE"
    health && echo "Rolled back. App is healthy." || { echo "Rolled back, but the health check failed — run --status."; exit 1; }
    exit 0 ;;
esac

echo "Running unit tests…"
node --test tests/*.test.js >/dev/null || { echo "Unit tests failed — not deploying."; exit 1; }

echo "Uploading to $PI…"
remote "mkdir -p $BASE/data $BASE/backups && rm -rf $BASE/app.new && mkdir -p $BASE/app.new"
tar czf - index.html css js assets server | remote "tar xzf - -C $BASE/app.new"
sed -e "s#__USER__#$PI_USER#g" -e "s#__HOME__#$PI_HOME#g" -e "s#__PORT__#$PORT#g" deploy/$SERVICE.service \
  | remote "cat > $BASE/app.new/$SERVICE.service"

# Install/refresh the service definition, then swap app.new into place (keeping app.prev).
remote "set -e
  sudo install -m 644 $BASE/app.new/$SERVICE.service /etc/systemd/system/$SERVICE.service
  sudo systemctl daemon-reload
  sudo systemctl enable $SERVICE >/dev/null 2>&1
  rm -rf $BASE/app.prev
  if [ -d $BASE/app ]; then mv $BASE/app $BASE/app.prev; fi
  mv $BASE/app.new $BASE/app
  sudo systemctl restart $SERVICE"

if health; then
  echo "Deployed. Open http://$PI_HOST:$PORT"
else
  echo "Health check FAILED — rolling back to the previous version."
  remote "test -d $BASE/app.prev && rm -rf $BASE/app.failed && mv $BASE/app $BASE/app.failed && mv $BASE/app.prev $BASE/app && sudo systemctl restart $SERVICE" || true
  remote "journalctl -u $SERVICE -n 20 --no-pager" || true
  exit 1
fi
