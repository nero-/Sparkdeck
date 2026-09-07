# Sparkdeck — development & operations targets
#   make dev-backend 	run API+mock world on :8936 (reload)
#   make dev-web    	vite dev server (proxies /api → :8936)
#   make web        	build web/dist (production, served by backend)
#   make serve      	run production server (real nodes)
#   make serve-mock 	run production server (mock world) on :8936
#   make test       	pytest (REST smoke, parsers)
#   make smoke      	real-server mock smoke (uvicorn + ws + ops + bench)
#   make doctor     	probe the REAL nodes read-only

PY ?= ./.venv/bin/python
PORT ?= 8936

.PHONY: all setup dev-backend dev-web web serve serve-mock test smoke doctor lint clean

all: web

setup: ## create venv + install backend + frontend deps
	./setup.sh

dev-backend:
	SPARKDECK_MOCK=1 SPARKDECK_PORT=$(PORT) ./scripts/dev-backend.sh

dev-web:
	cd web && npm run dev -- --port 5173

web: ## build the console into web/dist
	cd web && npm run build

serve: ## serve with the REAL clusters
	./scripts/run.sh

serve-mock: ## serve with the simulated world
	SPARKDECK_MOCK=1 ./scripts/run.sh --port $(PORT)

test:
	SPARKDECK_DATA_DIR=$$PWD/.tmpdata SPARKDECK_MOCK=1 $(PY) -m pytest tests/ -q
	rm -rf $$PWD/.tmpdata

smoke:
	$(PY) tests/mock_server_smoke.py

doctor:
	$(PY) -m sparkdeck doctor

lint:
	cd web && npx tsc --noEmit
	$(PY) -m py_compile $$(find backend -name '*.py')

clean:
	rm -rf .tmpdata .smoketmp web/dist backend/sparkdeck.egg-info
	find backend -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true
