import { type Inline, parseMarkdownLite } from '@/lib/markdown-lite';
import { Fragment } from 'react';

/**
 * The agent's reply as readable text: short paragraphs and bullets, with **bold** and `code`
 * drawn as elements. Parsed to data first (see markdown-lite), so no HTML is ever injected.
 */
export function Markdownish({ text, className = '' }: { text: string; className?: string }) {
  const blocks = parseMarkdownLite(text);
  return (
    <div className={`space-y-2 text-sm leading-relaxed text-ink-2 ${className}`}>
      {blocks.map((block, i) =>
        block.type === 'list' ? (
          // The index is the identity here: the list is static text parsed from one message.
          // biome-ignore lint/suspicious/noArrayIndexKey: static parsed content, never reordered
          <ul key={i} className="space-y-1.5">
            {block.items.map((item, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static parsed content, never reordered
              <li key={j} className="flex gap-2.5">
                <span
                  aria-hidden
                  className="mt-[0.55em] h-1 w-1 flex-shrink-0 rounded-full bg-ink-4"
                />
                <span className="min-w-0 flex-1">
                  <InlineRuns runs={item} />
                </span>
              </li>
            ))}
          </ul>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: static parsed content, never reordered
          <p key={i}>
            <InlineRuns runs={block.inline} />
          </p>
        ),
      )}
    </div>
  );
}

function InlineRuns({ runs }: { runs: Inline[] }) {
  return (
    <>
      {runs.map((run, i) => {
        const key = i;
        if (run.type === 'bold') {
          return (
            <strong key={key} className="font-semibold text-ink">
              {run.text}
            </strong>
          );
        }
        if (run.type === 'code') {
          return (
            <code
              key={key}
              className="rounded bg-raised px-1 py-0.5 font-mono text-[0.85em] text-ink"
            >
              {run.text}
            </code>
          );
        }
        return <Fragment key={key}>{run.text}</Fragment>;
      })}
    </>
  );
}
