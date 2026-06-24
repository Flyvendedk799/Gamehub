import type { Project } from '@/lib/types';
import Link from 'next/link';

/** A project tile — shared by the dashboard "recent projects" grid and the
 *  full /projects list so both stay visually identical. */
export default function ProjectCard({ project }: { project: Project }) {
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
      {/* Preview thumbnail placeholder */}
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
