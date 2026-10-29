#!/usr/bin/env bash
# Launch briefly in stage mode for screen recording, on a curated copy of the data.
#
#   scripts/stage-demo.sh            # reset the staged data from the seed and launch (dark theme)
#   scripts/stage-demo.sh light      # same, light theme
#   scripts/stage-demo.sh light jobs # open on the Jobs tab (tasks | jobs | school)
#   scripts/stage-demo.sh --keep     # relaunch without resetting (keep what you did last take)
#   scripts/stage-demo.sh --snapshot # save the current staged data as the new seed
#   scripts/stage-demo.sh --stop     # quit the staged instance only (the real app keeps running)
#
# The staged instance never touches ~/Library/Application Support/briefly. Pollers, scans and
# notifications are off in its settings, so nothing moves on camera unless you do it.
set -euo pipefail
cd "$(dirname "$0")/.."

STAGE_DIR="$PWD/.stage"
DATA="$STAGE_DIR/userData"
SEED="$STAGE_DIR/seed"
APP=/Applications/briefly.app/Contents/MacOS/briefly
THEME=dark
TAB=1
RESET=1

for arg in "$@"; do
  case "$arg" in
    light|dark) THEME="$arg" ;;
    tasks) TAB=1 ;; jobs) TAB=2 ;; school) TAB=3 ;;
    --keep) RESET=0 ;;
    --snapshot)
      mkdir -p "$SEED"
      cp "$DATA"/*.json "$SEED"/
      echo "seed updated from current staged data"
      exit 0 ;;
    --stop)
      pkill -f -- '--stage' 2>/dev/null || true
      echo "staged instance stopped"
      exit 0 ;;
    *) echo "unknown arg: $arg"; exit 1 ;;
  esac
done

[ -x "$APP" ] || { echo "briefly is not installed at $APP — run scripts/install-local.sh first"; exit 1; }

# Stop any previous staged instance (marked by the --stage argv so the real app is left alone).
pkill -f -- '--stage' 2>/dev/null || true
sleep 0.5

if [ "$RESET" = 1 ]; then
  if [ ! -d "$SEED" ]; then
    mkdir -p "$SEED"
    cp "$DATA"/*.json "$SEED"/
    echo "seed created from current staged data"
  fi
  # Wipe renderer storage too so the theme/tab state starts clean each take.
  find "$DATA" -mindepth 1 -maxdepth 1 ! -name '*.json' -exec rm -rf {} +
  cp "$SEED"/*.json "$DATA"/
fi

BRIEFLY_STAGE=1 BRIEFLY_USER_DATA="$DATA" BRIEFLY_THEME="$THEME" BRIEFLY_TAB="$TAB" \
  nohup "$APP" --stage >"$STAGE_DIR/stage.log" 2>&1 &
disown
echo "staged briefly launched ($THEME); data: $DATA"
