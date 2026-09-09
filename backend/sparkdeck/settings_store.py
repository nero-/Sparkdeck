"""Topology + settings store over SQLite (clusters / nodes / profiles / app
settings), including the seed of the operator's real two-cluster setup.
"""

from __future__ import annotations

import os
from pathlib import Path

import os

from .db import DB, jdumps, jloads
from .models import AppSettings, ClusterConfig, ClusterControl, NodeAddress, NodeConfig, ProfileDef

# ---------------- seeding (the operator's real topology) -------------------
#
# 2026-09: the two TP2 pairs were consolidated into ONE four-node SparkRing
# (GLM-5.3 Flash TP4/DCP1, managed mesh). One cluster, 4 ranks:
#   r0 = head / API (:8015) + liveness (:8016) + mesh supervisor + staging seed
#   r1..r3 = one quarter of the model each (glm-tp4-rN containers)

# Straight cable ring (no switch): r0.p0↔r1.p1, r1.p0↔r2.p1, r2.p0↔r3.p1,
# r3.p0↔r0.p1; primaries 198.18.0–3.0/24 with .10/.11 per edge. Node-to-node
# only — the controller host cannot reach these; kept last in failover order.
_RING_EDGES = {
    0: ("198.18.0.10", "198.18.3.10"),  # (cw edge, ccw edge) primary addresses
    1: ("198.18.1.10", "198.18.0.11"),
    2: ("198.18.2.10", "198.18.1.11"),
    3: ("198.18.3.11", "198.18.2.11"),
}

_SEED_RANKS = [
    # rank, name, role, lan, tailscale-alias
    (0, "gx10-r0", "head", "192.168.50.23", "gx10-r0-ts"),
    (1, "gx10-r1", "worker", "192.168.50.192", "gx10-r1-ts"),
    (2, "gx10-r2", "worker", "192.168.50.90", "gx10-r2-ts"),
    (3, "gx10-r3", "worker", "192.168.50.5", "gx10-r3-ts"),
]


def _seed_nodes(cluster_id: str) -> list[NodeConfig]:
    out = []
    for rank, name, role, lan, ts in _SEED_RANKS:
        cw, ccw = _RING_EDGES[rank]
        out.append(
            NodeConfig(
                id=f"{cluster_id}-n{rank}",
                cluster_id=cluster_id,
                name=name,
                role=role,  # type: ignore[arg-type]
                ssh_user="nero",
                env_rank=rank,
                api_port=8015 if rank == 0 else 0,  # 0 = no API on this rank
                addresses=[
                    NodeAddress(kind="lan", host=lan, label="LAN"),
                    NodeAddress(kind="tailscale", host=ts, label="Tailscale"),
                    NodeAddress(kind="fabric", host=cw, label="ring cw (node-to-node)"),
                    NodeAddress(kind="fabric", host=ccw, label="ring ccw (node-to-node)"),
                ],
            )
        )
    return out


def _sparkring_dir() -> str:
    override = os.environ.get("SPARKDECK_SPARKRING_DIR")
    if override and override.strip():
        return override
    return "~/Builds/sparkring-deploy"


def _seed_cluster(cluster_id: str = "c1") -> ClusterConfig:
    return ClusterConfig(
        id=cluster_id,
        name="SparkRing · gx10 ×4 (TP4)",
        kind="sparkring-tp4",
        accent_color="#22D3EE",
        notes="GLM-5.3 Flash TP4/DCP1 managed-mesh ring. API 192.168.50.23:8015 "
        "(OpenAI-compatible, LAN-only); liveness :8016/liveness; mesh 9975, "
        "graph control 9970/9971, master 29775. Lifecycle ONLY via "
        "sparkring.sh (managed suite) — never touch containers/routing directly.",
        control=ClusterControl(
            serve_dir=_sparkring_dir(),
            repo_dir=_sparkring_dir(),
            launcher="sparkring.sh",
            start_extra="",
            health_timeout_s=2700,
            head_node_id=f"{cluster_id}-n0",
            worker_node_id="",
        ),
        profiles=[
            ProfileDef(
                id=f"{cluster_id}-tp4-mtp3",
                cluster_id=cluster_id,
                key="tp4-mtp3",
                label="GLM-5.3 Flash — TP4/DCP1 · native MTP3 · NVFP4-spark",
                served_model_name="glm-5.3-flash-spark",
                model_dir_hint="~/models/glm53-flash-nvfp4-spark",
                kv_pin_gib=24.0,  # per rank, fp8 (fp8_ds_mla)
                context=1_048_576,
                speculator="native MTP depth 3",
                quant="nvfp4-spark",
                mm_images=None,
                mm_videos=None,
                kv_tokens=2_278_454,  # documented cluster-wide KV (fp8)
                notes="TP4, DCP1 (compact index, SparkCache off); 8192-token "
                "scheduler budget, prefill coalescing 4; ~175 GiB checkpoint "
                "per rank at ~/models/glm53-flash-nvfp4-spark; measured 8K: "
                "prefill ~3.5k tok/s, C1 decode 58 tok/s.",
            ),
        ],
    )


# Back-compat name used by tests + imports elsewhere.
const_SEED_CLUSTERS = {"c1": _seed_cluster("c1")}


async def seed_if_empty(db: DB) -> None:
    row = await db.fetch_one("SELECT COUNT(*) AS n FROM clusters")
    assert row is not None
    if row["n"] > 0:
        return
    for cid, cl in const_SEED_CLUSTERS.items():
        await db.execute(
            "INSERT INTO clusters(id,name,kind,accent_color,notes,control,ord) VALUES(?,?,?,?,?,?,?)",
            (cl.id, cl.name, cl.kind, cl.accent_color, cl.notes, cl.control.model_dump_json(),
             0 if cid == "c1" else 1),
        )
        for i, node in enumerate(_seed_nodes(cid)):
            await db.execute(
                "INSERT INTO nodes(id,cluster_id,name,role,ssh_user,ssh_port,ssh_alias,"
                "env_rank,addresses,api_port,interest_ifaces,enabled,ord)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (node.id, node.cluster_id, node.name, node.role, node.ssh_user, node.ssh_port,
                 node.ssh_alias, node.env_rank, node.addresses and jdumps([a.model_dump() for a in node.addresses]),
                 node.api_port, jdumps(node.interest_ifaces), int(node.enabled), i),
            )
        for i, prof in enumerate(reversed(cl.profiles)):
            await db.execute(
                "INSERT INTO profiles(id,cluster_id,key,label,served_model_name,model_dir_hint,"
                "kv_pin_gib,context,speculator,quant,mm_images,mm_videos,notes,ord)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (prof.id, prof.cluster_id, prof.key, prof.label, prof.served_model_name,
                 prof.model_dir_hint, prof.kv_pin_gib, prof.context, prof.speculator, prof.quant,
                 prof.mm_images, prof.mm_videos, prof.notes, 100 - i),
            )
    app = default_app_settings()
    await set_settings_row(db, "app", app.model_dump())


def default_app_settings() -> AppSettings:
    s = AppSettings()
    # Auto-detect the operator's bench repo (a directory containing
    # llm_decode_bench.py). $SPARKDECK_BENCH_DIR wins; otherwise look at
    # common Sibling locations of this install (the glm TP2 build dir).
    candidates: list[Path] = []
    env_dir = os.environ.get("SPARKDECK_BENCH_DIR")
    if env_dir:
        candidates.append(Path(env_dir))
    home = Path.home()
    candidates += [
        home / "Builds",                                   # 2026-09: tool moved to ~/Builds root
        home / "Builds" / "sparkring-deploy",
        home / "Agent" / "Builds" / "glm53-flash-dgx-spark-tp2" / "bench",
        home / "builds" / "glm53-flash-dgx-spark-tp2" / "bench",
        Path("/opt/glm53-flash-dgx-spark-tp2/bench"),
    ]
    for cand in candidates:
        if (cand / "llm_decode_bench.py").exists():
            s.bench.bench_repo_dir = str(cand)
            venv = cand / ".venv" / "bin" / "python"
            if venv.exists():
                s.bench.venv_python = str(venv)
            else:
                venv_b = cand / "bench" / ".venv" / "bin" / "python"
                if venv_b.exists():
                    s.bench.venv_python = str(venv_b)
            break
    return s


# ---------------- bootstrap: seed + topology migration ----------------------

TOPOLOGY_REV = 2  # 1 = TP2 pairs seed; 2 = single SparkRing TP4 cluster


async def _wipe_topology(db: DB) -> None:
    await db.execute("DELETE FROM profiles")
    await db.execute("DELETE FROM nodes")
    await db.execute("DELETE FROM clusters")


async def _seed_topology(db: DB) -> None:
    for i, cl in enumerate(const_SEED_CLUSTERS.values()):
        await db.execute(
            "INSERT INTO clusters(id,name,kind,accent_color,notes,control,ord) VALUES(?,?,?,?,?,?,?)",
            (cl.id, cl.name, cl.kind, cl.accent_color, cl.notes, cl.control.model_dump_json(), i),
        )
        for j, node in enumerate(_seed_nodes(cl.id)):
            await db.execute(
                "INSERT INTO nodes(id,cluster_id,name,role,ssh_user,ssh_port,ssh_alias,"
                "env_rank,addresses,api_port,interest_ifaces,enabled,ord)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (node.id, node.cluster_id, node.name, node.role, node.ssh_user, node.ssh_port,
                 node.ssh_alias, node.env_rank,
                 node.addresses and jdumps([a.model_dump() for a in node.addresses]),
                 node.api_port, jdumps(node.interest_ifaces), int(node.enabled), j),
            )
        for j, prof in enumerate(reversed(cl.profiles)):
            await db.execute(
                "INSERT INTO profiles(id,cluster_id,key,label,served_model_name,model_dir_hint,"
                "kv_pin_gib,context,speculator,quant,mm_images,mm_videos,notes,kv_tokens,ord)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (prof.id, prof.cluster_id, prof.key, prof.label, prof.served_model_name,
                 prof.model_dir_hint, prof.kv_pin_gib, prof.context, prof.speculator, prof.quant,
                 prof.mm_images, prof.mm_videos, prof.notes, prof.kv_tokens, 100 - j),
            )


async def _set_topology_rev(db: DB) -> None:
    rows = await db.fetch_all("SELECT value FROM settings WHERE key='app'")
    app = jloads(rows[0]["value"], {}) if rows else {}
    app["_topology_rev"] = TOPOLOGY_REV
    await set_settings_row(db, "app", app)


async def _app_row_ok(db: DB) -> bool:
    return bool(await db.fetch_one("SELECT key FROM settings WHERE key='app'"))


async def ensure_topology(db: DB) -> dict:
    """Seed when empty; migrate a rev-1 (TP2-pairs) layout to the current
    seed. Returns {"action": seeded|migrated|kept, "rev": n}."""
    row = await db.fetch_one("SELECT COUNT(*) AS n FROM clusters")
    assert row is not None
    if row["n"] == 0:
        await _seed_topology(db)
        if not await _app_row_ok(db):
            await set_settings_row(db, "app", default_app_settings().model_dump())
        await _set_topology_rev(db)
        return {"action": "seeded", "rev": TOPOLOGY_REV}
    rows = await db.fetch_all("SELECT control FROM clusters")
    legacy = any("glm53_pair_serve" in (r["control"] or "") for r in rows)
    if not legacy:
        if not await _app_row_ok(db):
            await set_settings_row(db, "app", default_app_settings().model_dump())
            await _set_topology_rev(db)
        return {"action": "kept", "rev": TOPOLOGY_REV}
    # legacy TP2-pairs layout: replace with the consolidated SparkRing seed
    await _wipe_topology(db)
    await _seed_topology(db)
    await _set_topology_rev(db)
    return {"action": "migrated", "rev": TOPOLOGY_REV}


async def seed_if_empty(db: DB) -> None:  # legacy entry (tests)
    await ensure_topology(db)


# ---------------- CRUD ------------------------------------------------------


async def get_topologies(db: DB) -> list[dict]:
    """Topology as plain dicts (contract shape: cluster + nodes + profiles)."""
    rows = await db.fetch_all("SELECT * FROM clusters ORDER BY ord, name")
    out: list[dict] = []
    for r in rows:
        nodes = await db.fetch_all(
            "SELECT * FROM nodes WHERE cluster_id=? ORDER BY ord, name", (r["id"],)
        )
        profs = await db.fetch_all(
            "SELECT * FROM profiles WHERE cluster_id=? ORDER BY ord, key", (r["id"],)
        )
        node_dicts = []
        for n in nodes:
            d = dict(n)
            d["addresses"] = jloads(n["addresses"], [])
            d["enabled"] = bool(d["enabled"])
            node_dicts.append(d)
        prof_dicts = [dict(p) for p in profs]
        out.append(
            {
                "id": r["id"], "name": r["name"], "kind": r["kind"],
                "accent_color": r["accent_color"], "notes": r["notes"],
                "control": jloads(r["control"], {}),
                "profiles": prof_dicts,
                "nodes": node_dicts,
            }
        )
    return out


async def get_cluster(db: DB, cluster_id: str) -> dict | None:
    tops = await get_topologies(db)
    for t in tops:
        if t["id"] == cluster_id:
            return t
    return None


async def upsert_cluster(db: DB, data: dict) -> None:
    await db.execute(
        "INSERT INTO clusters(id,name,kind,accent_color,notes,control,ord) VALUES(?,?,?,?,?,?,0)"
        " ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind,"
        " accent_color=excluded.accent_color, notes=excluded.notes, control=excluded.control",
        (data["id"], data["name"], data.get("kind", "tp2"), data["accent_color"],
         data.get("notes"), jdumps(data["control"])),
    )


async def upsert_node(db: DB, data: dict) -> None:
    await db.execute(
        "INSERT INTO nodes(id,cluster_id,name,role,ssh_user,ssh_port,ssh_alias,env_rank,"
        "addresses,api_port,interest_ifaces,enabled,ord) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0)"
        " ON CONFLICT(id) DO UPDATE SET name=excluded.name, role=excluded.role,"
        " ssh_user=excluded.ssh_user, ssh_port=excluded.ssh_port, ssh_alias=excluded.ssh_alias,"
        " env_rank=excluded.env_rank, addresses=excluded.addresses, api_port=excluded.api_port,"
        " interest_ifaces=excluded.interest_ifaces, enabled=excluded.enabled",
        (data["id"], data["cluster_id"], data["name"], data["role"], data.get("ssh_user", "nero"),
         data.get("ssh_port", 22), data.get("ssh_alias"), int(data.get("env_rank", 0)),
         jdumps(data.get("addresses", [])), data.get("api_port", 8000),
         jdumps(data.get("interest_ifaces", [])), int(data.get("enabled", True))),
    )


async def upsert_profile(db: DB, data: dict) -> None:
    await db.execute(
        "INSERT INTO profiles(id,cluster_id,key,label,served_model_name,model_dir_hint,"
        "kv_pin_gib,context,speculator,quant,mm_images,mm_videos,notes,ord) VALUES"
        "(?,?,?,?,?,?,?,?,?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET key=excluded.key,"
        " label=excluded.label, served_model_name=excluded.served_model_name,"
        " model_dir_hint=excluded.model_dir_hint, kv_pin_gib=excluded.kv_pin_gib,"
        " context=excluded.context, speculator=excluded.speculator, quant=excluded.quant,"
        " mm_images=excluded.mm_images, mm_videos=excluded.mm_videos, notes=excluded.notes",
        (data["id"], data["cluster_id"], data["key"], data.get("label", ""),
         data.get("served_model_name", "zai-org/GLM-5.3-Flash"), data.get("model_dir_hint"),
         data.get("kv_pin_gib"), data.get("context"), data.get("speculator"), data.get("quant"),
         data.get("mm_images"), data.get("mm_videos"), data.get("notes")),
    )


async def delete_cluster(db: DB, cluster_id: str) -> None:
    await db.execute("DELETE FROM clusters WHERE id=?", (cluster_id,))


async def delete_node(db: DB, node_id: str) -> None:
    await db.execute("DELETE FROM nodes WHERE id=?", (node_id,))


async def delete_profile(db: DB, profile_id: str) -> None:
    await db.execute("DELETE FROM profiles WHERE id=?", (profile_id,))


# ---------------- app settings ----------------------------------------------

async def set_settings_row(db: DB, key: str, value: dict) -> None:
    await db.execute(
        "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, jdumps(value)),
    )


async def get_app_settings(db: DB) -> AppSettings:
    row = await db.fetch_one("SELECT value FROM settings WHERE key='app'")
    if not row:
        return default_app_settings()
    data = jloads(row["value"], {})
    try:
        return AppSettings.model_validate(data)
    except Exception:
        base = default_app_settings()
        merged = base.model_dump()
        for k, v in data.items():
            if k in merged and isinstance(v, dict) and isinstance(merged[k], dict):
                merged[k].update({kk: vv for kk, vv in v.items() if kk in merged[k]})
            elif k in merged:
                merged[k] = v
        return AppSettings.model_validate(merged)


async def patch_app_settings(db: DB, patch: dict) -> AppSettings:
    cur = (await get_app_settings(db)).model_dump()
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(cur.get(k), dict):
            cur[k].update(v)
        elif k in cur:
            cur[k] = v
    s = AppSettings.model_validate(cur)
    await set_settings_row(db, "app", s.model_dump())
    return s
