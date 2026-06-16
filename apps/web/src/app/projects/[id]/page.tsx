'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatPanel } from '@/components/ChatPanel';
import { PreviewPane } from '@/components/PreviewPane';
import { generateGame, getChatHistory, getProject, publishProject, streamRun } from '@/lib/api';
import { useCollab } from '@/lib/use-collab';
import type { ChatHistoryMessage, Project, RunCompleteEvent, RunErrorEvent, SseEvent } from '@/lib/types';

const BASE = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3191';

function chatMessageToEvents(msg: ChatHistoryMessage): SseEvent[] {
  if (msg.kind === 'user') {
    const p = msg.payload as { text?: string; runId?: string } | null;
    return [{
      type: 'message_update',
      runId: p?.runId ?? '',
      role: 'assistant',
      content: `> ${p?.text ?? ''}`,
      timestamp: msg.createdAt,
    }];
  }
  if (msg.kind === 'artifact_delivered') {
    const p = msg.payload as { runId?: string; previewUrl?: string } | null;
    return [{
      type: 'run_complete',
      runId: p?.runId ?? '',
      snapshotPath: '',
      previewUrl: p?.previewUrl ?? '',
      timestamp: msg.createdAt,
    }];
  }
  return [];
}

export default function BuilderPage() {
  const params = useParams();
  const searchParams = useSearchParams();

  const projectId = typeof params['id'] === 'string' ? params['id'] : '';
  const initialRunId = searchParams.get('runId') ?? null;

  const [project, setProject] = useState<Project | null>(null);
  const [events, setEvents] = useState<SseEvent[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [hasError, setHasError] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [currentRunId, setCurrentRunId] = useState<string | null>(initialRunId);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishUrl, setPublishUrl] = useState<string | null>(null);

  // CRDT collab — syncs a shared Y.Doc across all browser tabs on this project
  const { peerCount, connected: collabConnected } = useCollab(projectId || null);

  // Track active SSE controller so we can close it on unmount / new run
  const streamCtrlRef = useRef<{ close: () => void } | null>(null);

  // ─── Load project metadata + chat history ─────────────────────────────────
  useEffect(() => {
    if (!projectId) return;
    void getProject(projectId)
      .then(({ project }) => setProject(project))
      .catch(() => {});

    void getChatHistory(projectId)
      .then(({ messages }) => {
        if (messages.length === 0) return;

        const syntheticEvents: SseEvent[] = [];
        let lastPreviewUrl: string | null = null;

        for (const msg of messages) {
          syntheticEvents.push(...chatMessageToEvents(msg));
          if (msg.kind === 'artifact_delivered') {
            const p = (msg.payload as { previewUrl?: string } | null);
            if (p?.previewUrl) lastPreviewUrl = p.previewUrl;
          }
        }

        setEvents(syntheticEvents);
        if (lastPreviewUrl) {
          const url = lastPreviewUrl.startsWith('http')
            ? lastPreviewUrl
            : `${BASE}${lastPreviewUrl}`;
          setPreviewUrl(url);
        }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // ─── Start streaming when runId changes ───────────────────────────────────
  const startStream = useCallback((runId: string) => {
    // Close any existing stream
    streamCtrlRef.current?.close();
    setIsStreaming(true);
    setHasError(false);
    setErrorMessage(undefined);

    const ctrl = streamRun(
      runId,
      (event) => {
        setEvents((prev) => [...prev, event]);

        if (event.type === 'run_complete') {
          const completeEvent = event as RunCompleteEvent;
          // Build full preview URL from the path returned by the server
          const url = completeEvent.previewUrl.startsWith('http')
            ? completeEvent.previewUrl
            : `${BASE}${completeEvent.previewUrl}`;
          setPreviewUrl(url);
          setIsStreaming(false);
          streamCtrlRef.current?.close();
        }

        if (event.type === 'run_error') {
          const errEvent = event as RunErrorEvent;
          setHasError(true);
          setErrorMessage(errEvent.error);
          setIsStreaming(false);
          streamCtrlRef.current?.close();
        }

        if (event.type === 'agent_end') {
          setIsStreaming(false);
        }
      },
      () => {
        // SSE error / connection closed
        setIsStreaming(false);
      },
    );

    streamCtrlRef.current = ctrl;
  }, []);

  useEffect(() => {
    if (initialRunId) {
      startStream(initialRunId);
    }

    return () => {
      streamCtrlRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Send a new prompt (iterate) ──────────────────────────────────────────
  async function handleSend(prompt: string) {
    if (!projectId || isStreaming) return;

    // Add a synthetic "user" message to the log
    const userEvent: SseEvent = {
      type: 'message_update',
      runId: currentRunId ?? '',
      role: 'assistant',
      content: `> ${prompt}`,
      timestamp: new Date().toISOString(),
    };
    setEvents((prev) => [...prev, userEvent]);

    try {
      const { runId } = await generateGame(projectId, prompt);
      setCurrentRunId(runId);
      startStream(runId);
    } catch (err) {
      const errEvent: SseEvent = {
        type: 'run_error',
        runId: currentRunId ?? '',
        error: err instanceof Error ? err.message : 'Failed to start generation',
        timestamp: new Date().toISOString(),
      };
      setEvents((prev) => [...prev, errEvent]);
    }
  }

  async function handlePublish() {
    if (!projectId || isPublishing || !previewUrl) return;
    setIsPublishing(true);
    try {
      const { publishUrl: url } = await publishProject(projectId);
      const full = url.startsWith('http') ? url : `${BASE}${url}`;
      setPublishUrl(full);
    } catch (err) {
      console.error('Publish failed:', err);
    } finally {
      setIsPublishing(false);
    }
  }

  const isBuilding = isStreaming;

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0a] overflow-hidden">
      {/* Top nav bar */}
      <header className="flex-shrink-0 h-12 border-b border-[#222222] bg-[#111111] flex items-center px-4 gap-4 z-10">
        <Link href="/" className="flex items-center gap-2 group flex-shrink-0">
          <div className="w-6 h-6 rounded-md bg-[#6366f1] flex items-center justify-center">
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <polygon points="2,1 9,5.5 2,10" fill="white" />
            </svg>
          </div>
          <span className="text-xs font-semibold text-[#f4f4f5] hidden sm:block group-hover:text-[#6366f1] transition-colors">
            Playforge
          </span>
        </Link>

        <div className="w-px h-5 bg-[#222222] flex-shrink-0" />

        <div className="flex-1 min-w-0">
          {project ? (
            <h1 className="text-sm font-medium text-[#f4f4f5] truncate">{project.name}</h1>
          ) : (
            <div className="h-3.5 w-40 bg-[#1a1a1a] rounded animate-pulse" />
          )}
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          {isBuilding && (
            <span className="flex items-center gap-1.5 text-xs text-[#6366f1] font-mono">
              <PulseRing />
              building
            </span>
          )}
          {previewUrl && (
            <>
              <a
                href={previewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="
                  text-xs px-3 py-1.5 rounded-lg
                  bg-[#6366f1]/10 hover:bg-[#6366f1]/20
                  text-[#6366f1] border border-[#6366f1]/20
                  transition-colors font-medium
                "
              >
                Full screen ↗
              </a>
              {publishUrl ? (
                <a
                  href={publishUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="
                    text-xs px-3 py-1.5 rounded-lg
                    bg-emerald-500/10 hover:bg-emerald-500/20
                    text-emerald-400 border border-emerald-500/20
                    transition-colors font-medium
                  "
                >
                  Published ↗
                </a>
              ) : (
                <button
                  onClick={() => { void handlePublish(); }}
                  disabled={isPublishing || isStreaming}
                  className="
                    text-xs px-3 py-1.5 rounded-lg
                    bg-emerald-500/10 hover:bg-emerald-500/20
                    text-emerald-400 border border-emerald-500/20
                    transition-colors font-medium
                    disabled:opacity-40 disabled:cursor-not-allowed
                  "
                >
                  {isPublishing ? 'Publishing…' : 'Publish'}
                </button>
              )}
            </>
          )}
          {collabConnected && peerCount > 0 && (
            <span className="flex items-center gap-1 text-xs text-emerald-400 font-medium" title="Live collaborators">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              {peerCount} with you
            </span>
          )}
          <Link
            href="/projects"
            className="text-xs text-[#52525b] hover:text-[#a1a1aa] transition-colors"
          >
            All projects
          </Link>
        </div>
      </header>

      {/* Main split */}
      <div className="flex flex-1 overflow-hidden">
        {/* Chat panel — 35% */}
        <div className="w-[35%] min-w-[280px] max-w-[480px] flex-shrink-0 overflow-hidden">
          <ChatPanel
            events={events}
            onSend={(prompt) => { void handleSend(prompt); }}
            isStreaming={isStreaming}
          />
        </div>

        {/* Preview pane — 65% */}
        <div className="flex-1 overflow-hidden">
          <PreviewPane
            previewUrl={previewUrl}
            isBuilding={isBuilding}
            hasError={hasError}
            errorMessage={errorMessage}
          />
        </div>
      </div>
    </div>
  );
}

function PulseRing() {
  return (
    <span className="relative flex h-1.5 w-1.5">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#6366f1] opacity-75" />
      <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-[#6366f1]" />
    </span>
  );
}
