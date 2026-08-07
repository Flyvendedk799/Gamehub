'use client';

import ProjectCard from '@/components/ProjectCard';
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
    <div className="min-h-dvh bg-ground">
      <main className="mx-auto max-w-5xl px-6 py-10 md:py-14">
        <div className="mb-8 flex flex-col gap-4 border-b border-hairline pb-4 sm:flex-row sm:items-baseline sm:justify-between">
          <h1 className="type-title text-2xl text-ink">Your projects</h1>
          <Link
            href="/"
            className="inline-flex w-full items-center justify-center gap-1.5 bg-signal px-4 py-3 text-base font-bold text-chrome transition-colors hover:bg-signal-bright sm:w-auto sm:px-4 sm:py-1.5 sm:text-sm"
          >
            + New game
          </Link>
        </div>

        {loading && (
          <div className="flex items-center gap-3 font-mono text-[11px] tracking-[.12em] text-ink-3">
            <PulseIcon />
            LOADING PROJECTS…
          </div>
        )}

        {error && (
          <div className="border border-fail/40 bg-fail/10 px-4 py-3 text-sm text-fail">
            {error}
          </div>
        )}

        {!loading && !error && projects.length === 0 && (
          <div className="border border-dashed border-hairline py-24 text-center">
            <p className="text-sm text-ink-4">Slot zero is empty.</p>
            <Link
              href="/"
              className="mt-4 inline-block text-sm text-signal transition-colors hover:text-signal-bright"
            >
              Build your first game →
            </Link>
          </div>
        )}

        {!loading && projects.length > 0 && (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function PulseIcon() {
  return (
    <span className="relative flex h-2 w-2">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-signal opacity-75" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-signal" />
    </span>
  );
}
