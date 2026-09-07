#!/usr/bin/env bash
# pristine backend dev loop (mock world + autoreload)
cd "$(dirname "$0")/.." || exit 1
exec ./.venv/bin/uvicorn sparkdeck.server:app_factory --factory --reload --host 127.0.0.1 \
  --port "${SPARKDECK_PORT:-8936}" --log-level info
