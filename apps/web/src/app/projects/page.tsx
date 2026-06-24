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
    <div className="min-h-screen bg-[#0a0a0a]">
      <main className="max-w-5xl mx-auto px-6 py-10">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold text-[#f4f4f5]">Your projects</h1>
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-[#6366f1] hover:bg-[#4f46e5] text-white rounded-lg transition-all"
          >
            + New game
          </Link>
        </div>

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

function PulseIcon() {
  return (
    <span className="relative flex h-2 w-2">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#6366f1] opacity-75" />
      <span className="relative inline-flex rounded-full h-2 w-2 bg-[#6366f1]" />
    </span>
  );
}
