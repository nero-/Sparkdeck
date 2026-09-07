"""Domain models — mirror of web/src/api/types.ts (the shared contract).

Field names are identical to the TS contract (snake_case everywhere).
"""

from __future__ import annotations

import uuid
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, field_validator

IDT = str


def new_id() -> str:
    return uuid.uuid4().hex[:12]


# ---------------- topology ----------------


class NodeAddress(BaseModel):
    kind: Literal["lan", "fabric", "tailscale", "custom"] = "lan"
    host: str
    label: str | None = None


class NodeConfig(BaseModel):
    id: IDT = Field(default_factory=new_id)
    cluster_id: IDT
    name: str
    role: Literal["head", "worker"] = "worker"
    ssh_user: str = "nero"
    ssh_port: int = 22
    ssh_alias: str | None = None
    env_rank: int = 0
    addresses: list[NodeAddress] = Field(default_factory=list)
    api_port: int = 8000
    interest_ifaces: list[str] = Field(default_factory=list)
    enabled: bool = True

    @field_validator("addresses")
    @classmethod
    def _nonempty_hosts(cls, v: list[NodeAddress]) -> list[NodeAddress]:
        return [a for a in v if a.host.strip()]


class ProfileDef(BaseModel):
    id: IDT = Field(default_factory=new_id)
    cluster_id: IDT
    key: str
    label: str = ""
    served_model_name: str = "zai-org/GLM-5.3-Flash"
    model_dir_hint: str | None = None
    kv_pin_gib: float | None = None
    context: int | None = None
    speculator: str | None = None
    quant: str | None = None
    mm_images: int | None = None
    mm_videos: int | None = None
    notes: str | None = None


class ClusterControl(BaseModel):
    repo_dir: str = "~/builds/glm53-flash-dgx-spark-tp2"
    serve_dir: str = (
        "~/builds/glm53-flash-dgx-spark-tp2/serve/"
        "TP2-DGX-Spark-GLM5.3F-Jovian-Judgement"
    )
    launcher: str = "glm53_pair_serve.sh"
    start_extra: str = "--recurrent-checkpoint-policy request_boundaries"
    health_timeout_s: int = 720
    head_node_id: IDT = ""
    worker_node_id: IDT = ""


class ClusterConfig(BaseModel):
    id: IDT = Field(default_factory=new_id)
    name: str
    kind: Literal["tp2"] = "tp2"
    accent_color: str = "#22D3EE"
    notes: str | None = None
    control: ClusterControl = Field(default_factory=ClusterControl)
    profiles: list[ProfileDef] = Field(default_factory=list)


# ---------------- settings ----------------


class RetentionSettings(BaseModel):
    raw_hours: int = 12
    minute_days: int = 14
    decaminute_days: int = 60


class AlertSettings(BaseModel):
    mem_warn_gib: float = 118.5
    mem_crit_gib: float = 120.5
    gpu_temp_warn_c: float = 80.0
    gpu_temp_crit_c: float = 90.0
    container_restarts: int = 3
    webhook_url: str | None = None


class AppearanceSettings(BaseModel):
    theme: Literal["dark", "light", "system"] = "dark"
    density: Literal["comfortable", "compact"] = "comfortable"


class BenchArgs(BaseModel):
    concurrency: str = "1,2,3,4"
    contexts: str = "0,8192,32768"
    prefill_contexts: str = "8k,32k"
    max_tokens: int = 2048
    duration: int = 30
    coding_peak: bool = False
    coding_peak_runs: int | None = None
    coding_peak_max_tokens: int | None = None
    kv_budget: int | None = None
    extra: str = ""


class BenchDefaults(BaseModel):
    label: str = "adhoc"
    args: BenchArgs = Field(default_factory=BenchArgs)


class BenchSettings(BaseModel):
    bench_repo_dir: str | None = None
    venv_python: str | None = None
    write_repo_runs: bool = False
    defaults: BenchDefaults = Field(default_factory=BenchDefaults)


class ImageSettings(BaseModel):
    filter_glob: str = "local/vllm:*"
    hmm_guard_pause_s: int = 2


class SecuritySettings(BaseModel):
    bind_host: str = "127.0.0.1"
    port: int = 8936
    token_set: bool = False


class AppSettings(BaseModel):
    sampling_interval_s: float = 2.0
    retention: RetentionSettings = Field(default_factory=RetentionSettings)
    alerts: AlertSettings = Field(default_factory=AlertSettings)
    appearance: AppearanceSettings = Field(default_factory=AppearanceSettings)
    bench: BenchSettings = Field(default_factory=BenchSettings)
    images: ImageSettings = Field(default_factory=ImageSettings)
    security: SecuritySettings = Field(default_factory=SecuritySettings)


# ---------------- live / ops ----------------


class SampleFrame(BaseModel):
    node_id: str
    ts: int
    series: dict[str, float | None]


class OpStep(BaseModel):
    name: str
    state: Literal["pending", "running", "ok", "error", "skipped", "cancelled"] = "pending"
    detail: str | None = None


class OpRecord(BaseModel):
    id: IDT = Field(default_factory=new_id)
    kind: str
    cluster_id: IDT | None = None
    profile_key: str | None = None
    node_id: IDT | None = None
    state: Literal["queued", "running", "ok", "error", "cancelled"] = "queued"
    created: Annotated[int, "epoch ms"] = 0
    started: int | None = None
    finished: int | None = None
    exit: int | None = None
    message: str | None = None
    steps: list[OpStep] = Field(default_factory=list)
    log_tail: list[str] = Field(default_factory=list)  # bounded tail, newest last
    params: dict[str, Any] = Field(default_factory=dict)


class EventRec(BaseModel):
    id: str
    ts: int
    level: Literal["info", "warn", "error"] = "info"
    kind: str
    cluster_id: IDT | None = None
    node_id: IDT | None = None
    message: str
    data: dict[str, Any] | None = None
    acked: bool = False


class ServiceState(BaseModel):
    cluster_id: str
    health: Literal["up", "down", "degraded", "unknown"] = "unknown"
    host: str | None = None
    port: int | None = None
    model: str | None = None
    served_models: list[str] = Field(default_factory=list)
    image: str | None = None
    profile_key: str | None = None
    age_s: float | None = None
    kv_tokens: int | None = None
    metrics: dict[str, float] = Field(default_factory=dict)
    errors: list[str] = Field(default_factory=list)


class SeriesDef(BaseModel):
    id: str
    unit: str
    kind: Literal["gauge", "counter"] = "gauge"
    label: str = ""
    group: str = "other"
    cluster_scoped: bool = False


class LiveNodeState(BaseModel):
    node_id: str
    cluster_id: str
    state: Literal["connecting", "online", "degraded", "offline", "disabled"] = "offline"
    addr_used: str | None = None
    conn_since: int | None = None
    collector: Literal["healthy", "stale", "down", "none", "unprobed"] = "unprobed"
    last_sample_ts: int | None = None


# ---------------- bench / images / llm ----------------


class BenchJob(BaseModel):
    id: IDT = Field(default_factory=new_id)
    cluster_id: IDT
    profile_key: str | None = None
    label: str = "run"
    host: str = ""
    port: int = 8000
    model: str = ""
    args: BenchArgs = Field(default_factory=BenchArgs)
    state: Literal["queued", "running", "ok", "error", "cancelled"] = "queued"
    created: int = 0
    started: int | None = None
    finished: int | None = None
    exit: int | None = None
    result_path: str | None = None
    log_path: str | None = None
    summary: dict[str, Any] | None = None


class ChatMsg(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMsg]
    model: str | None = None
    max_tokens: int | None = None
    temperature: float | None = None
    top_p: float | None = None
