#!/usr/bin/env bash
# sparkdeck launcher — production serve (backend + built console).
cd "$(dirname "$0")/.." || exit 1
export SPARKDECK_MOCK="${SPARKDECK_MOCK:-0}"
exec ./.venv/bin/python -m sparkdeck serve "$@"
