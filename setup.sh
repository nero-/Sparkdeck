#!/usr/bin/env bash
# one-time setup: venv + backend deps + editable install + frontend deps
set -euo pipefail
cd "$(dirname "$0")"
python3 -m venv .venv
./.venv/bin/pip install -q --upgrade pip || true
./.venv/bin/pip install -q fastapi 'uvicorn[standard]' asyncssh pydantic websockets \
  && ./.venv/bin/pip install -q -e . --no-deps
cd web && npm install
echo "setup complete — try: make serve-mock"
