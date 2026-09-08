/* Bench — the operator's benchmark console.
   Top: runner form (defaults prefill from GET /api/bench/config; argv preview
   mirrored client-side, POST argv is the truth). Middle: live job card +
   console. Bottom: history (sparkdeck + repo runs, delta arrows per host). */

import { useEffect, useState } from 'react';
import { fetchBenchConfig, fetchBenchJobs, fetchClusters, type BenchJobCreated } from '../../api/admin';
import { useQuery } from '../../api/queries';
import { PageHeader } from '../../shell/PageShell';
import { Chip } from '../../ds';
import { RunnerForm, type RunnerSubmitSnapshot } from './RunnerForm';
import { JobView } from './JobView';
import { HistoryTable } from './HistoryTable';
import { useServiceByCluster } from '../../stores/live';
import type { ID, ServiceState } from '../../api/types';

export default function BenchPage() {
  const clustersQ = useQuery(fetchClusters);
  const configQ = useQuery(fetchBenchConfig);
  const serviceByCluster = useServiceByCluster();

  const clusters = clustersQ.data ?? [];
  const serviceOf = (clusterId: ID): ServiceState | undefined => serviceByCluster[clusterId];

  /* active job — set by a submission, or restored from the jobs list on mount
     (a queued/running job survives refreshes) */
  const [active, setActive] = useState<{ jobId: string; argv: string[] | null; clusterId: ID | null; label: string | null } | null>(null);
  const [historySignal, setHistorySignal] = useState(0);

  useEffect(() => {
    fetchBenchJobs(6)
      .then((jobs) => {
        const running = jobs.find((j) => j.state === 'running' || j.state === 'queued');
        if (running !== undefined) {
          setActive({ jobId: running.id, argv: null, clusterId: running.cluster_id, label: running.label });
        }
      })
      .catch(() => {
        /* bench jobs staying unreachable is non-fatal for the page */
      });
  }, []);

  const activeClusterName = active !== null ? (clusters.find((c) => c.id === active.clusterId)?.name ?? null) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Bench"
        context="llm-inference-bench sweeps: concurrency × contexts, checkpointed cells, repo-run history"
        actions={
          <>
            {active !== null && <Chip variant="accent">job {active.jobId} in view</Chip>}
            {configQ.data !== null && (
              <Chip
                variant={configQ.data.tool_present && configQ.data.venv_deps_ok !== false ? 'ok' : 'crit'}
                title="GET /api/bench/config — tool presence + venv deps"
              >
                {configQ.data.tool_present ? (configQ.data.venv_deps_ok === false ? 'venv deps broken' : 'bench ready') : 'bench tool missing'}
              </Chip>
            )}
          </>
        }
      />

      <div className="flex min-w-0 flex-col gap-6 pb-16">
        {clustersQ.error !== null ? (
          <div className="sd-panel p-5 text-sm text-crit">
            clusters unreachable — the bench runner needs a cluster to target.{' '}
            <span className="font-mono text-2xs">{String(clustersQ.error instanceof Error ? clustersQ.error.message : clustersQ.error)}</span>
          </div>
        ) : (
          <RunnerForm
            clusters={clusters}
            config={configQ.data}
            configLoading={configQ.loading}
            serviceOf={serviceOf}
            onSubmitted={(created: BenchJobCreated, snap: RunnerSubmitSnapshot) => {
              if (created.job_id !== null) {
                setActive({
                  jobId: created.job_id,
                  argv: created.argv.length > 0 ? created.argv : null,
                  clusterId: snap.clusterId,
                  label: snap.label,
                });
              }
            }}
          />
        )}

        {active !== null && (
          <div className="flex flex-col gap-2">
            <JobView
              jobId={active.jobId}
              truthArgv={active.argv}
              activeClusterName={activeClusterName}
              onSettled={() => setHistorySignal((n) => n + 1)}
              onDismiss={() => setActive(null)}
            />
          </div>
        )}

        <HistoryTable refreshSignal={historySignal} />
      </div>
    </div>
  );
}
