'use client';

import { listProjects } from '@/lib/api';
import type { Project } from '@/lib/types';
import Link from 'next/link';
import { useEffect, useState } from 'react';

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProjects()
      .then(({ projects }) => setProjects(projects))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load projects');
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      {/* Nav */}
      <header className="border-b border-[#222222] bg-[#111111]">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 group">
            <div className="w-7 h-7 rounded-lg bg-[#6366f1] flex items-center justify-center">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <polygon points="2,1 12,7 2,13" fill="white" />
              </svg>
            </div>
            <span className="text-sm font-semibold text-[#f4f4f5] group-hover:text-[#6366f1] transition-colors">
              Playforge
            </span>
          </Link>
          <Link href="/" className="text-sm text-[#a1a1aa] hover:text-[#f4f4f5] transition-colors">
            + New game
          </Link>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-bold text-[#f4f4f5] mb-8">Your projects</h1>

        {loading && (
          <div className="flex items-center gap-3 text-[#a1a1aa]">
            <PulseIcon />
            Loading projects…
          </div>
        )}

        {error && (
          <div className="text-[#ef4444] bg-[#ef4444]/10 border border-[#ef4444]/20 rounded-lg px-4 py-3 text-sm">
            {error}
          </div>
        )}

        {!loading && !error && projects.length === 0 && (
          <div className="text-center py-24 border border-dashed border-[#222222] rounded-2xl">
            <p className="text-[#52525b] text-sm">No projects yet.</p>
            <Link href="/" className="mt-4 inline-block text-sm text-[#6366f1] hover:underline">
              Build your first game →
            </Link>
          </div>
        )}

        {!loading && projects.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const created = new Date(project.createdAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <Link
      href={`/projects/${project.id}`}
      className="
        group block bg-[#111111] border border-[#222222] rounded-2xl p-5
        hover:border-[#6366f1]/50 hover:shadow-lg hover:shadow-indigo-500/5
        transition-all duration-200
      "
    >
      {/* Engine badge + preview thumbnail placeholder */}
      <div className="h-32 rounded-xl bg-[#0a0a0a] border border-[#1a1a1a] mb-4 flex items-center justify-center">
        <svg
          width="32"
          height="32"
          viewBox="0 0 32 32"
          fill="none"
          className="opacity-20"
          aria-hidden="true"
        >
          <polygon points="6,4 26,16 6,28" fill="#6366f1" />
        </svg>
      </div>

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-[#f4f4f5] truncate group-hover:text-[#6366f1] transition-colors">
            {project.name}
          </h2>
          <p className="mt-1 text-xs text-[#52525b]">{created}</p>
        </div>
        <span className="flex-shrink-0 text-[10px] font-mono uppercase tracking-widest px-2 py-1 rounded-md bg-[#1a1a1a] text-[#52525b] border border-[#222222]">
          {project.engine}
        </span>
      </div>
    </Link>
  );
}

function PulseIcon() {
  return (
    <span className="relative flex h-2 w-2">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#6366f1] opacity-75" />
      <span className="relative inline-flex rounded-full h-2 w-2 bg-[#6366f1]" />
    </span>
  );
}
