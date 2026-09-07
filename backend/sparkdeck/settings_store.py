"""Topology + settings store over SQLite (clusters / nodes / profiles / app
settings), including the seed of the operator's real two-cluster setup.
"""

from __future__ import annotations

from pathlib import Path

from .db import DB, jdumps, jloads
from .models import AppSettings, ClusterConfig, ClusterControl, NodeAddress, NodeConfig, ProfileDef

# ---------------- seeding (the operator's real topology) -------------------

_KV = {"mtp3-spark": 10.5, "mtp3-nvfp4": 6.5, "df-spark": 12.5, "df-nvfp4": 4.5}
_CTX = {"mtp3-spark": 524288, "mtp3-nvfp4": 524288, "df-spark": 262144, "df-nvfp4": 262144}
_MMV = {"mtp3-spark": 0, "mtp3-nvfp4": 0, "df-spark": 0, "df-nvfp4": 1}
_SPEC = {"mtp3-spark": "mtp3-adaptive", "mtp3-nvfp4": "mtp3-adaptive", "df-spark": "dflash2", "df-nvfp4": "dflash2"}
_QUANT = {"mtp3-spark": "spark", "mtp3-nvfp4": "nvfp4", "df-spark": "spark", "df-nvfp4": "nvfp4"}
_LABEL = {
    "mtp3-spark": "MTP3 · spark quant · daily driver",
    "mtp3-nvfp4": "MTP3 · non-spark NVFP4",
    "df-spark": "DFlash2@7 · spark quant",
    "df-nvfp4": "DFlash2@7 · non-spark · video",
}
_PROFILE_ORDER = ["mtp3-spark", "mtp3-nvfp4", "df-spark", "df-nvfp4"]

_GLM_PROFILES = {
    "mtp3-spark": ProfileDef(
        id="c1-mtp3-spark", cluster_id="c1", key="mtp3-spark",
        label=_LABEL["mtp3-spark"], kv_pin_gib=_KV["mtp3-spark"], context=_CTX["mtp3-spark"],
        speculator=_SPEC["mtp3-spark"], quant=_QUANT["mtp3-spark"], mm_images=4, mm_videos=0,
    ),
    "mtp3-nvfp4": ProfileDef(
        id="c1-mtp3-nvfp4", cluster_id="c1", key="mtp3-nvfp4",
        label=_LABEL["mtp3-nvfp4"], kv_pin_gib=_KV["mtp3-nvfp4"], context=_CTX["mtp3-nvfp4"],
        speculator=_SPEC["mtp3-nvfp4"], quant=_QUANT["mtp3-nvfp4"], mm_images=4, mm_videos=0,
    ),
    "df-spark": ProfileDef(
        id="c1-df-spark", cluster_id="c1", key="df-spark",
        label=_LABEL["df-spark"], kv_pin_gib=_KV["df-spark"], context=_CTX["df-spark"],
        speculator=_SPEC["df-spark"], quant=_QUANT["df-spark"], mm_images=4, mm_videos=0,
        notes="DFlash2 draft is CC BY-NC-ND (non-commercial).",
    ),
    "df-nvfp4": ProfileDef(
        id="c1-df-nvfp4", cluster_id="c1", key="df-nvfp4",
        label=_LABEL["df-nvfp4"], kv_pin_gib=_KV["df-nvfp4"], context=_CTX["df-nvfp4"],
        speculator=_SPEC["df-nvfp4"], quant=_QUANT["df-nvfp4"], mm_images=4, mm_videos=1,
        notes="DFlash2 draft is CC BY-NC-ND (non-commercial).",
    ),
}


def _glm_profiles_for(cluster_id: str) -> list[ProfileDef]:
    out = []
    for key in _PROFILE_ORDER:
        p = _GLM_PROFILES[key].model_copy(deep=True)
        p.cluster_id = cluster_id
        p.id = f"{cluster_id}-{key}"
        out.append(p)
    return out


_SEED_NODES = [
    # cluster, name, role, lan, fabric, ts-alias, env_rank
    ("c1", "gx10-r0", "head", "192.168.50.23", "10.100.80.2", "gx10-r0-ts", 0),
    ("c1", "gx10-r1", "worker", "192.168.50.192", "10.100.80.1", "gx10-r1-ts", 1),
    ("c2", "gx10-r2", "head", "192.168.50.90", "10.100.120.2", "gx10-r2-ts", 2),
    ("c2", "gx10-r3", "worker", "192.168.50.5", "10.100.120.1", "gx10-r3-ts", 3),
]


def _seed_nodes(cluster_id: str) -> list[NodeConfig]:
    out = []
    for cid, name, role, lan, fabric, ts, rank in _SEED_NODES:
        if cid != cluster_id:
            continue
        out.append(
            NodeConfig(
                id=f"{cid}-n{rank}",
                cluster_id=cluster_id,
                name=name,
                role=role,  # type: ignore[arg-type]
                ssh_user="nero",
                env_rank=rank,
                addresses=[
                    NodeAddress(kind="lan", host=lan, label="LAN"),
                    NodeAddress(kind="tailscale", host=ts, label="Tailscale"),
                    NodeAddress(kind="fabric", host=fabric, label="CX7 rail (node-to-node only)"),
                ],
            )
        )
    return out


const_SEED_CLUSTERS = {
    "c1": ClusterConfig(
        id="c1",
        name="Cluster 1 · gx10-r0/r1",
        accent_color="#22D3EE",
        notes="Primary pair. History: the agent runtime rode inside this pair's "
        "containers until 2026-09-07 — treat lifecycle ops with care.",
        control=ClusterControl(head_node_id="c1-n0", worker_node_id="c1-n1"),
        profiles=_glm_profiles_for("c1"),
    ),
    "c2": ClusterConfig(
        id="c2",
        name="Cluster 2 · gx10-r2/r3",
        accent_color="#A78BFA",
        notes="Second pair on the LAN switch (10.100.120.x rail). Same image line, same four profiles.",
        control=ClusterControl(head_node_id="c2-n2", worker_node_id="c2-n3"),
        profiles=_glm_profiles_for("c2"),
    ),
}


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
    if Path(
        "/home/kal/Agent/Builds/glm53-flash-dgx-spark-tp2/bench/llm_decode_bench.py"
    ).exists():
        s.bench.bench_repo_dir = "/home/kal/Agent/Builds/glm53-flash-dgx-spark-tp2/bench"
        s.bench.venv_python = "/home/kal/Agent/Builds/glm53-flash-dgx-spark-tp2/bench/.venv/bin/python"
    return s


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
