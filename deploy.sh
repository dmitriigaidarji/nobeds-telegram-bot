#!/usr/bin/env bash
#
# Deploy to the server and (re)start under pm2.
#
# Rsync rather than `git pull`, so what ships is exactly the tree that was
# tested here - no push, no deploy key on the server, no "works on the branch
# I forgot to commit".
#
#   ./deploy.sh                 typecheck + test, sync, install, restart
#   ./deploy.sh --with-env      also upload .env (overwrites the server's)
#   ./deploy.sh --skip-checks   skip typecheck/tests
#   ./deploy.sh --logs          tail the logs afterwards
#
# Two things are never touched on the server: data/ (the SQLite file holding
# every chat's registered links) and .env (the bot token), unless --with-env
# says otherwise. The booking snapshot lives in /tmp and is disposable, so it
# is not synced, backed up, or preserved.

set -euo pipefail

cd "$(dirname "$0")"

# The deployment target is deliberately not in the repository. It is read from
# .env (gitignored) or the environment, so a public checkout carries no
# hostname, no login, and no server paths.
read_env() {
  [ -f .env ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" .env |
    tail -n 1 | sed 's/^"\(.*\)"$/\1/; s/^'"'"'\(.*\)'"'"'$/\1/'
}

APP="nobeds-telegram"
HOST="${DEPLOY_HOST:-$(read_env DEPLOY_HOST)}"
REMOTE_DIR="${DEPLOY_DIR:-$(read_env DEPLOY_DIR)}"
REMOTE_BUN="${DEPLOY_BUN:-$(read_env DEPLOY_BUN)}"
REMOTE_BUN="${REMOTE_BUN:-/usr/local/bin/bun}"

if [ -z "$HOST" ] || [ -z "$REMOTE_DIR" ]; then
  cat >&2 <<'MSG'
error: no deployment target configured.

Add these to .env (which is gitignored), or set them in the environment:

  DEPLOY_HOST=user@host
  DEPLOY_DIR=/path/to/deploy/nobeds-telegram
  DEPLOY_BUN=/usr/local/bin/bun    # optional
MSG
  exit 2
fi

WITH_ENV=0
SKIP_CHECKS=0
TAIL_LOGS=0
for arg in "$@"; do
  case "$arg" in
    --with-env) WITH_ENV=1 ;;
    --skip-checks) SKIP_CHECKS=1 ;;
    --logs) TAIL_LOGS=1 ;;
    -h|--help) awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# --- verify before shipping ------------------------------------------------

if [ "$SKIP_CHECKS" -eq 0 ]; then
  say "Typecheck"
  bun run typecheck
  say "Tests"
  bun test
fi

if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  echo
  echo "note: working tree has uncommitted changes - they WILL be deployed."
fi

# --- sync ------------------------------------------------------------------

say "Preparing $HOST:$REMOTE_DIR"
ssh "$HOST" "mkdir -p '$REMOTE_DIR/logs' '$REMOTE_DIR/data' && chmod 700 '$REMOTE_DIR/data'"

say "Syncing source"
# --delete keeps the remote clean, and the excludes are what makes that safe:
# the database, the secrets, the logs and node_modules all live only there.
#
# --no-owner --no-group because -a would otherwise stamp the remote files with
# this machine's numeric uid/gid, which means nothing over there.
rsync -az --delete --no-owner --no-group \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'data/' \
  --exclude 'logs/' \
  --exclude '.env' \
  --exclude '*.db' \
  --exclude '*.db-wal' \
  --exclude '*.db-shm' \
  --exclude '.DS_Store' \
  ./ "$HOST:$REMOTE_DIR/"

# --- secrets ---------------------------------------------------------------

if [ "$WITH_ENV" -eq 1 ]; then
  if [ ! -f .env ]; then
    echo "error: --with-env given but there is no local .env" >&2
    exit 1
  fi
  say "Uploading .env"
  rsync -az .env "$HOST:$REMOTE_DIR/.env"
  ssh "$HOST" "chmod 600 '$REMOTE_DIR/.env'"
else
  # A missing .env means the process would crash-loop on a missing bot token.
  # Better to stop here than to hand pm2 something that cannot start.
  if ! ssh "$HOST" "test -f '$REMOTE_DIR/.env'"; then
    echo >&2
    echo "error: no .env on the server. Re-run with --with-env to upload yours," >&2
    echo "       or create $REMOTE_DIR/.env there (see .env.example)." >&2
    exit 1
  fi
  ssh "$HOST" "chmod 600 '$REMOTE_DIR/.env'"
fi

# --- install and start -----------------------------------------------------

say "Installing dependencies"
ssh "$HOST" "cd '$REMOTE_DIR' && '$REMOTE_BUN' install --production --frozen-lockfile"

say "Starting under pm2"
# startOrRestart covers both the first deploy and every one after it.
# --update-env so a changed .env is actually picked up.
ssh "$HOST" "cd '$REMOTE_DIR' && pm2 startOrRestart ecosystem.config.cjs --update-env && pm2 save"

# --- confirm it actually came up -------------------------------------------

say "Health check"
sleep 6
ssh "$HOST" "pm2 describe $APP | grep -E 'status|restarts|uptime' || true"

echo
echo "Recent log lines:"
ssh "$HOST" "tail -n 15 '$REMOTE_DIR/logs/out.log' 2>/dev/null || echo '(no output yet)'"

# Only the tail: out.log accumulates, so grepping the whole file would happily
# match a successful start from three deploys ago.
if ssh "$HOST" "tail -n 20 '$REMOTE_DIR/logs/out.log' 2>/dev/null | grep -q 'running as @'"; then
  echo
  echo "✅ Bot connected to Telegram."
else
  echo
  echo "⚠️  No 'running as @' line yet - check: ssh $HOST 'pm2 logs $APP'"
fi

if [ "$TAIL_LOGS" -eq 1 ]; then
  ssh -t "$HOST" "pm2 logs $APP"
fi
