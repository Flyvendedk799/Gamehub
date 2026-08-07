import { engineLabel } from '@/lib/engine-label';
import { placeholderGradient, resolveThumbnailUrl } from '@/lib/thumbnail';
import type { Project } from '@/lib/types';
import Link from 'next/link';

/** Compact relative edit time in the board's mono voice: "EDITED 2H AGO". */
function editedLabel(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'EDITED —';
  const mins = Math.max(0, Math.floor((Date.now() - then) / 60_000));
  if (mins < 1) return 'EDITED JUST NOW';
  if (mins < 60) return `EDITED ${mins}M AGO`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `EDITED ${hours}H AGO`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'EDITED YESTERDAY';
  if (days < 30) return `EDITED ${days}D AGO`;
  return `EDITED ${new Date(iso)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    .toUpperCase()}`;
}

/** A project tile — shared by the dashboard "recent projects" grid and the
 *  full /projects list so both stay visually identical. Identity board 1b:
 *  hairline-framed surface, 16:10 capture area with a mono engine label, and a
 *  signal border on hover as the single interactive cue. */
export default function ProjectCard({ project }: { project: Project }) {
  // Gameplay thumbnail captured after the latest build; null until the first
  // build completes — fall back to the quiet duotone slot.
  const thumb = resolveThumbnailUrl(project.thumbnailUrl);

  return (
    <Link
      href={`/projects/${project.id}`}
      className="group block border border-hairline bg-surface transition-colors hover:border-signal"
    >
      {/* Gameplay thumbnail (or the empty-slot placeholder until captured) */}
      <div
        className="relative flex aspect-[16/10] items-end overflow-hidden p-3.5"
        style={thumb ? undefined : { background: placeholderGradient(project.id) }}
      >
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element -- content-addressed
          // blob thumbnails from the API, not statically optimizable by next/image.
          <img
            src={thumb}
            alt=""
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <span className="type-label-xs pointer-events-none absolute inset-0 flex items-center justify-center tracking-[.12em] text-signal/70">
            No capture
          </span>
        )}
        <span className="type-label-xs relative tracking-[.12em] text-ink-4">
          {engineLabel(project.engine)}
        </span>
      </div>

      <div className="border-t border-hairline p-4">
        <h2 className="truncate text-base font-bold tracking-[-.015em] text-ink">{project.name}</h2>
        <div className="mt-1.5 font-mono text-[11px] tracking-[.06em] text-ink-4">
          {editedLabel(project.updatedAt)}
        </div>
      </div>
    </Link>
  );
}
