#!/usr/bin/env bash
# Daily launch entry for the hxaxd project workbench.
#
# Starts two local processes:
#   1. the workbench backend (FastAPI) on 127.0.0.1:$BACKEND_PORT;
#   2. the upstream DSH web server on 127.0.0.1:$DSH_PORT, booted with the
#      isolated "hxaxd" profile ($DSH_HOME/profiles/hxaxd) that loads our
#      @hxaxd/dsh-ui-projects client module and disables the replaced
#      upstream workspace UI.
#
# All workbench state (project registry, managed project directories, DSH
# sessions and workspace records) lives under $DATA_DIR, separate from any
# other DSH installation on this machine.
#
# Environment overrides:
#   HXAXD_DATA_DIR     workbench data root   (default: backend/data)
#   HXAXD_DSH_HOME     DSH home              (default: $DATA_DIR/dsh-home)
#   HXAXD_DSH_PORT     DSH web port          (default: 3080)
#   HXAXD_BACKEND_PORT backend port          (default: 8642)
#   DEEPSEEK_API_KEY   model credential, read by DSH (or configure models in the UI)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${HXAXD_DATA_DIR:-$REPO_ROOT/backend/data}"
DSH_HOME="${HXAXD_DSH_HOME:-$DATA_DIR/dsh-home}"
DSH_PORT="${HXAXD_DSH_PORT:-3080}"
BACKEND_PORT="${HXAXD_BACKEND_PORT:-8642}"
DSH_VERSION="0.1.7-rc.2"
export DSH_HOME

echo "==> building the workbench UI plugin (ui-projects)"
(cd "$REPO_ROOT/frontend" && npm install --no-audit --no-fund --silent && npm run build --silent)

echo "==> preparing the isolated DSH profile at $DSH_HOME/profiles/hxaxd"
PROFILE_DIR="$DSH_HOME/profiles/hxaxd"
mkdir -p "$PROFILE_DIR"
cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "hxaxd-workbench-profile",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
    }
  },
  "dependencies": {
    "@hxaxd/dsh-ui-projects": "file:$REPO_ROOT/frontend/ui-projects"
  }
}
EOF
cp "$REPO_ROOT/frontend/profile/cordis.patch.yml" "$PROFILE_DIR/cordis.patch.yml"
(cd "$PROFILE_DIR" && npm install --no-audit --no-fund --silent --no-package-lock)

echo "==> starting the workbench backend on 127.0.0.1:$BACKEND_PORT"
(
  cd "$REPO_ROOT/backend"
  exec env HXAXD_BACKEND_PORT="$BACKEND_PORT" HXAXD_DATA_DIR="$DATA_DIR" \
    uv run --quiet python -m app
) &
BACKEND_PID=$!
cleanup() { kill "$BACKEND_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "==> starting DSH web on 127.0.0.1:$DSH_PORT (profile: hxaxd)"
cd "$REPO_ROOT"
npx -y "@deepseek-ai/dsh@$DSH_VERSION" --profile hxaxd --port "$DSH_PORT" --no-open
