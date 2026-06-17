'use client';

import { useEffect, useState } from 'react';
import { API_BASE } from '@/lib/config';

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
    <div className="bg-[#111111] border border-[#222222] rounded-xl p-5">
      <p className="text-xs text-[#52525b] font-medium uppercase tracking-wide mb-1">{label}</p>
      <p className="text-2xl font-bold text-[#f4f4f5] tabular-nums">{value}</p>
      {sub && <p className="text-xs text-[#71717a] mt-1">{sub}</p>}
    </div>
  );
}

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 h-2 bg-[#1a1a1a] rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="text-xs text-[#71717a] w-8 text-right">{pct}%</span>
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
        const j = await res.json() as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json() as Metrics;
      setMetrics(data);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'fetch failed');
    } finally {
      setLoading(false);
    }
  }

  // Auto-refresh every 15s when metrics are loaded.
  useEffect(() => {
    if (!metrics) return;
    const id = setInterval(() => void fetchMetrics(token), 15_000);
    return () => clearInterval(id);
  }, [metrics, token]);

  const runs = metrics?.runs;
  const hub = metrics?.hub;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#f4f4f5] p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-xl font-bold">Build Health Dashboard</h1>
          {lastRefresh && (
            <p className="text-xs text-[#52525b] mt-0.5">
              Last updated {lastRefresh.toLocaleTimeString()} · refreshes every 15s
            </p>
          )}
        </div>
        <a href="/" className="text-xs text-[#52525b] hover:text-[#a1a1aa] transition-colors">
          ← Back to Playforge
        </a>
      </div>

      {/* Token input */}
      <div className="flex gap-3 mb-8">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void fetchMetrics(token); }}
          placeholder="Admin token (leave blank if none configured)"
          className="flex-1 bg-[#111111] border border-[#222222] rounded-lg px-4 py-2 text-sm text-[#f4f4f5] placeholder-[#3f3f46] outline-none focus:border-[#6366f1] transition-colors"
        />
        <button
          onClick={() => void fetchMetrics(token)}
          disabled={loading}
          className="px-4 py-2 rounded-lg bg-[#6366f1] hover:bg-[#4f46e5] text-white text-sm font-medium transition-colors disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Fetch'}
        </button>
      </div>

      {error && (
        <div className="mb-6 bg-rose-500/10 border border-rose-500/20 rounded-xl px-4 py-3 text-sm text-rose-400">
          {error === 'forbidden' ? 'Invalid admin token' : error}
        </div>
      )}

      {metrics && (
        <div className="space-y-8">
          {/* Generation runs */}
          <section>
            <h2 className="text-sm font-semibold text-[#a1a1aa] uppercase tracking-wide mb-4">Generation Runs</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              <StatCard label="Total" value={runs?.total ?? 0} />
              <StatCard label="Completed" value={runs?.completed ?? 0} />
              <StatCard label="Failed" value={runs?.failed ?? 0} />
              <StatCard label="Active" value={runs?.active ?? 0} sub="queued + running" />
            </div>
            {runs && runs.total > 0 && (
              <div className="bg-[#111111] border border-[#222222] rounded-xl p-5 space-y-3">
                <div>
                  <div className="flex justify-between text-xs mb-1.5">
                    <span className="text-[#71717a]">Success rate</span>
                    <span className="text-emerald-400 font-medium">{Math.round(runs.successRate * 100)}%</span>
                  </div>
                  <Bar value={runs.completed} max={runs.total} color="#10b981" />
                </div>
                <div>
                  <div className="flex justify-between text-xs mb-1.5">
                    <span className="text-[#71717a]">Failure rate</span>
                    <span className="text-rose-400 font-medium">{Math.round((runs.failed / runs.total) * 100)}%</span>
                  </div>
                  <Bar value={runs.failed} max={runs.total} color="#f43f5e" />
                </div>
              </div>
            )}
          </section>

          {/* Community Hub */}
          {hub && (
            <section>
              <h2 className="text-sm font-semibold text-[#a1a1aa] uppercase tracking-wide mb-4">Community Hub</h2>
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
              <h2 className="text-sm font-semibold text-[#a1a1aa] uppercase tracking-wide mb-4">Generation Queue (BullMQ)</h2>
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
            <h2 className="text-sm font-semibold text-[#a1a1aa] uppercase tracking-wide mb-4">Realtime Presence</h2>
            <div className="grid grid-cols-2 gap-3">
              <StatCard label="Projects with viewers" value={metrics.presenceProjects} />
              <StatCard label="Connected sockets" value={metrics.connectedSockets} />
            </div>
          </section>
        </div>
      )}

      {!metrics && !error && !loading && (
        <div className="text-center py-20 text-[#52525b] text-sm">
          Enter your admin token and click Fetch to load metrics.
        </div>
      )}
    </div>
  );
}
