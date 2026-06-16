'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { getCreatorProfile } from '@/lib/api';
import type { CreatorProfile } from '@/lib/api';

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export default function CreatorProfilePage() {
  const params = useParams<{ handle: string }>();
  const handle = params?.handle ?? '';

  const [profile, setProfile] = useState<CreatorProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!handle) return;
    setLoading(true);
    setError(null);
    getCreatorProfile(handle)
      .then(setProfile)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load profile');
      })
      .finally(() => setLoading(false));
  }, [handle]);

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      {/* Nav */}
      <header className="border-b border-[#222222] bg-[#111111]">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="flex items-center gap-2 group">
              <div className="w-7 h-7 rounded-lg bg-[#6366f1] flex items-center justify-center">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <polygon points="2,1 12,7 2,13" fill="white" />
                </svg>
              </div>
              <span className="text-sm font-semibold text-[#f4f4f5] group-hover:text-[#6366f1] transition-colors">
                Playforge
              </span>
            </Link>

            <div className="w-px h-5 bg-[#222222]" />

            <nav className="flex items-center gap-3">
              <Link
                href="/hub"
                className="text-xs text-[#71717a] hover:text-[#f4f4f5] transition-colors"
              >
                Hub
              </Link>
              <Link
                href="/projects"
                className="text-xs text-[#71717a] hover:text-[#f4f4f5] transition-colors"
              >
                Projects
              </Link>
            </nav>
          </div>

          <Link
            href="/"
            className="text-xs px-3 py-1.5 rounded-lg bg-[#6366f1]/10 hover:bg-[#6366f1]/20 text-[#6366f1] border border-[#6366f1]/20 transition-colors font-medium"
          >
            Make a game
          </Link>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-10">
        {/* Loading skeleton */}
        {loading && (
          <div className="animate-pulse">
            <div className="h-8 bg-[#111111] rounded w-48 mb-2" />
            <div className="h-4 bg-[#111111] rounded w-24 mb-10" />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="bg-[#111111] border border-[#222222] rounded-xl p-4">
                  <div className="h-4 bg-[#1a1a1a] rounded w-3/4 mb-3" />
                  <div className="h-3 bg-[#1a1a1a] rounded w-1/3" />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Error state */}
        {!loading && error && (
          <div className="text-[#ef4444] bg-[#ef4444]/10 border border-[#ef4444]/20 rounded-lg px-4 py-3 text-sm">
            {error}
          </div>
        )}

        {/* Profile loaded */}
        {!loading && !error && profile && (
          <>
            {/* Hero */}
            <div className="mb-10">
              <h1 className="text-3xl font-bold text-[#f4f4f5] tracking-tight">
                @{profile.handle}
              </h1>
              <p className="text-sm text-[#52525b] mt-1">
                {profile.projectCount} {profile.projectCount === 1 ? 'game' : 'games'}
              </p>
            </div>

            {/* Grid */}
            {profile.projects.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-24 border border-dashed border-[#222222] rounded-2xl text-center">
                <div className="w-12 h-12 rounded-xl bg-[#111111] border border-[#222222] flex items-center justify-center mb-4">
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                    <polygon points="4,2.5 16,10 4,17.5" fill="#3f3f46" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-[#71717a]">No public games yet</p>
                <p className="text-xs text-[#52525b] mt-1">Check back later!</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {profile.projects.map((project) => (
                  <ProjectCard key={project.id} project={project} />
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

type ProjectItem = CreatorProfile['projects'][number];

function ProjectCard({ project }: { project: ProjectItem }) {
  const updated = relativeTime(project.updatedAt);
  const engineLabel = project.engine ?? 'unknown';

  return (
    <div className="group bg-[#111111] border border-[#222222] rounded-xl p-4 hover:border-[#333333] transition-colors">
      {/* Header row */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <h2 className="text-sm font-semibold text-[#f4f4f5] truncate group-hover:text-[#6366f1] transition-colors">
          {project.name}
        </h2>
        <EngineBadge engine={engineLabel} />
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-[#52525b]">Updated {updated}</span>
        <Link
          href={`/projects/${project.id}`}
          className="text-xs px-2.5 py-1 rounded-md bg-[#6366f1]/10 hover:bg-[#6366f1]/20 text-[#6366f1] border border-[#6366f1]/20 transition-colors font-medium"
        >
          Builder
        </Link>
      </div>
    </div>
  );
}

function EngineBadge({ engine }: { engine: string }) {
  const isPhaserOrThree = engine === 'phaser' || engine === 'three';
  return (
    <span
      className={`flex-shrink-0 text-[10px] font-mono uppercase tracking-widest px-2 py-0.5 rounded-md border ${
        isPhaserOrThree
          ? 'bg-[#6366f1]/10 text-[#6366f1] border-[#6366f1]/20'
          : 'bg-[#1a1a1a] text-[#52525b] border-[#222222]'
      }`}
    >
      {engine}
    </span>
  );
}
