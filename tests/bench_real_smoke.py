"""Real bench smoke through the BenchRunner (needs network + serving pair)."""
import asyncio, sys, time
sys.path.insert(0, 'backend')
from pathlib import Path
from sparkdeck.config import RuntimeConfig
from sparkdeck.app import Application
from sparkdeck.models import BenchJob
from sparkdeck.settings_store import ensure_topology, get_app_settings

async def main():
    data = Path(__file__).resolve().parents[1] / '.tmpdata'
    cfg = RuntimeConfig(data_dir=data)
    a = Application(cfg)
    await a.db.connect()
    await ensure_topology(a.db)
    a.settings_ref.settings = await get_app_settings(a.db)
    await a.reload_topology()
    job = BenchJob(cluster_id='c1', profile_key='tp4-mtp3', label='sparkdeck-smoke',
                   host='192.168.50.23', port=8015, model='glm-5.3-flash-spark', created=int(time.time()*1000))
    job.args.concurrency = "1"; job.args.contexts = "0"; job.args.prefill_contexts = "8k"
    job.args.max_tokens = 128; job.args.duration = 8; job.args.kv_budget = None
    argv = a.bench._argv(job)
    print("result path:", argv[argv.index('--output') + 1], flush=True)
    t0 = time.time()
    await a.bench.submit(job, argv)
    print(f"bench wall {time.time()-t0:.1f}s — state: {job.state} exit: {job.exit}", flush=True)
    s = job.summary or {}
    print("error:", s.get("error"), flush=True)
    print("engine:", s.get("engine"), "server:", s.get("server_url"), "spec_avg:", s.get("spec_accept_avg"), flush=True)
    print("best:", s.get("best"), "| c1:", s.get("c1"), flush=True)
    print("prefill:", s.get("prefill"), flush=True)
    for g in (s.get("grid") or [])[:4]:
        print("  cell:", g, flush=True)
    print("report:", await a.bench.write_report(job.id), flush=True)
    rows = await a.bench.list(3)
    print("jobs stored:", [(j.id, j.state) for j in rows], flush=True)
    hists = await a.bench.repo_history(3)
    print("repo history:", [(h['label'], h['summary'].get('best')) for h in hists], flush=True)
    for rt in list(a.runtimes.values()):
        await rt.stop()
    await a.db.close()

asyncio.run(main())
print("DONE")
