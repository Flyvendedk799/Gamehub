'use client';

import { API_BASE } from '@/lib/config';
import { useEffect, useState } from 'react';

const BASE = API_BASE;

interface RunStats {
  total: number;
  completed: number;
  failed: number;
  active: number;
  successRate: number;
}

interface HubStats {
  totalPublished: number;
  totalPlays: number;
  totalLikes: number;
  totalComments: number;
}

interface QueueStats {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

interface Metrics {
  runs: RunStats;
  hub: HubStats | null;
  queue: QueueStats | null;
  presenceProjects: number;
  connectedSockets: number;
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="border border-hairline bg-surface p-5">
      <p className="type-label-xs mb-2 tracking-[.14em] text-ink-4">{label}</p>
      <p className="font-mono text-2xl font-bold tabular-nums text-ink">{value}</p>
      {sub && <p className="mt-1 text-xs text-ink-4">{sub}</p>}
    </div>
  );
}

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="h-0.5 flex-1 overflow-hidden bg-hairline">
        <div
          className="h-full transition-all duration-500"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <span className="w-8 text-right font-mono text-xs text-ink-4">{pct}%</span>
    </div>
  );
}

export default function AdminDashboard() {
  const [token, setToken] = useState('');
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  async function fetchMetrics(t: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${BASE}/v1/admin/metrics`, {
        headers: t ? { 'x-admin-token': t } : {},
      });
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as Metrics;
      setMetrics(data);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'fetch failed');
    } finally {
      setLoading(false);
    }
  }

  // Auto-refresh every 15s when metrics are loaded.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally excludes fetchMetrics (recreated each render) to avoid tearing down and rebuilding the interval on every render
  useEffect(() => {
    if (!metrics) return;
    const id = setInterval(() => void fetchMetrics(token), 15_000);
    return () => clearInterval(id);
  }, [metrics, token]);

  const runs = metrics?.runs;
  const hub = metrics?.hub;

  return (
    <div className="mx-auto min-h-dvh max-w-4xl bg-ground p-6 text-ink">
      <div className="mb-8 flex items-center justify-between border-b border-hairline pb-5">
        <div>
          <div className="type-label mb-2 text-ink-4">Operations</div>
          <h1 className="type-title text-xl text-ink">Build health</h1>
          {lastRefresh && (
            <p className="mt-1 font-mono text-[10px] tracking-[.08em] text-ink-4">
              UPDATED {lastRefresh.toLocaleTimeString()} · REFRESHES EVERY 15S
            </p>
          )}
        </div>
        <a href="/" className="text-xs text-ink-4 transition-colors hover:text-ink-3">
          ← Back to PlayerZero
        </a>
      </div>

      {/* Token input */}
      <div className="mb-8 flex gap-3">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void fetchMetrics(token);
          }}
          placeholder="Admin token (leave blank if none configured)"
          className="flex-1 border border-hairline bg-surface px-4 py-3 text-sm text-ink placeholder-ink-4 outline-none transition-colors focus:border-signal"
        />
        <button
          type="button"
          onClick={() => void fetchMetrics(token)}
          disabled={loading}
          className="bg-signal px-4 py-3 text-sm font-bold text-chrome transition-colors hover:bg-signal-bright disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Fetch'}
        </button>
      </div>

      {error && (
        <div className="mb-6 border border-fail/40 bg-fail/10 px-4 py-3 text-sm text-fail">
          {error === 'forbidden' ? 'Invalid admin token' : error}
        </div>
      )}

      {metrics && (
        <div className="space-y-8">
          {/* Generation runs */}
          <section>
            <h2 className="type-label mb-4 text-ink-3">Generation runs</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              <StatCard label="Total" value={runs?.total ?? 0} />
              <StatCard label="Completed" value={runs?.completed ?? 0} />
              <StatCard label="Failed" value={runs?.failed ?? 0} />
              <StatCard label="Active" value={runs?.active ?? 0} sub="queued + running" />
            </div>
            {runs && runs.total > 0 && (
              <div className="space-y-3 border border-hairline bg-surface p-5">
                <div>
                  <div className="mb-1.5 flex justify-between font-mono text-xs">
                    <span className="text-ink-4">SUCCESS RATE</span>
                    <span className="font-medium text-pass">
                      {Math.round(runs.successRate * 100)}%
                    </span>
                  </div>
                  <Bar value={runs.completed} max={runs.total} color="#b6f24a" />
                </div>
                <div>
                  <div className="mb-1.5 flex justify-between font-mono text-xs">
                    <span className="text-ink-4">FAILURE RATE</span>
                    <span className="font-medium text-fail">
                      {Math.round((runs.failed / runs.total) * 100)}%
                    </span>
                  </div>
                  <Bar value={runs.failed} max={runs.total} color="#ff5d3b" />
                </div>
              </div>
            )}
          </section>

          {/* Community Hub */}
          {hub && (
            <section>
              <h2 className="type-label mb-4 text-ink-3">Community hub</h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatCard label="Published" value={hub.totalPublished} />
                <StatCard label="Total Plays" value={hub.totalPlays.toLocaleString()} />
                <StatCard label="Likes" value={hub.totalLikes.toLocaleString()} />
                <StatCard label="Comments" value={hub.totalComments.toLocaleString()} />
              </div>
            </section>
          )}

          {/* BullMQ queue depth */}
          {metrics.queue && (
            <section>
              <h2 className="type-label mb-4 text-ink-3">Generation queue (BullMQ)</h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatCard label="Waiting" value={metrics.queue.waiting} />
                <StatCard label="Active" value={metrics.queue.active} />
                <StatCard label="Delayed" value={metrics.queue.delayed} />
                <StatCard label="Failed" value={metrics.queue.failed} />
              </div>
            </section>
          )}

          {/* Presence */}
          <section>
            <h2 className="type-label mb-4 text-ink-3">Realtime presence</h2>
            <div className="grid grid-cols-2 gap-3">
              <StatCard label="Projects with viewers" value={metrics.presenceProjects} />
              <StatCard label="Connected sockets" value={metrics.connectedSockets} />
            </div>
          </section>
        </div>
      )}

      {!metrics && !error && !loading && (
        <div className="py-20 text-center text-sm text-ink-4">
          Enter your admin token and click Fetch to load metrics.
        </div>
      )}
    </div>
  );
}
