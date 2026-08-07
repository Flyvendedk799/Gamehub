'use client';

import {
  ApiError,
  type ProjectFileEntry,
  type ReadProjectFileResponse,
  describeApiError,
  fetchProjectZip,
  listProjectFiles,
  readProjectFile,
  writeProjectFile,
} from '@/lib/api';
import {
  type FileKind,
  type FileNode,
  buildFileTree,
  fileKind,
  formatBytes,
} from '@/lib/files-tree';
import { CODE_HIGHLIGHT_CSS, highlightToHtml, langFromPath } from '@/lib/syntax-highlight';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface FilesPanelProps {
  projectId: string;
  previewUrl: string | null;
  onFileSaved?: () => void;
  /** Bubbles the editor's unsaved state up so PreviewPane can guard tab switches. */
  onDirtyChange?: (dirty: boolean) => void;
  /** True while a generation is streaming — manual saves are paused so a hand-edit
   *  can't race the build's HEAD advance. */
  isBuilding?: boolean;
}

/** Inject the token-color CSS once, the first time any FilesPanel mounts. */
let cssInjected = false;
function useHighlightCss(): void {
  useEffect(() => {
    if (cssInjected || typeof document === 'undefined') return;
    const style = document.createElement('style');
    style.dataset['pfCodeHighlight'] = 'true';
    style.textContent = CODE_HIGHLIGHT_CSS;
    document.head.appendChild(style);
    cssInjected = true;
  }, []);
}

export function FilesPanel({
  projectId,
  previewUrl,
  onFileSaved,
  onDirtyChange,
  isBuilding,
}: FilesPanelProps) {
  useHighlightCss();

  const [files, setFiles] = useState<ProjectFileEntry[]>([]);
  const [totalBytes, setTotalBytes] = useState(0);
  const [engine, setEngine] = useState<'phaser' | 'three' | null>(null);
  const [listState, setListState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [listError, setListError] = useState<string | null>(null);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [treeOpen, setTreeOpen] = useState(false); // mobile drawer toggle (< md)

  // Confirm before navigating away from a file with unsaved edits (tree click or
  // mobile-drawer pick). Selecting the SAME file is a no-op (no prompt).
  const selectFile = useCallback(
    (path: string) => {
      if (path === selectedPath) {
        setTreeOpen(false);
        return;
      }
      if (editorDirty && !window.confirm('Discard unsaved changes?')) return;
      setEditorDirty(false);
      onDirtyChange?.(false);
      setSelectedPath(path);
      setTreeOpen(false);
    },
    [selectedPath, editorDirty, onDirtyChange],
  );

  const handleDirtyChange = useCallback(
    (dirty: boolean) => {
      setEditorDirty(dirty);
      onDirtyChange?.(dirty);
    },
    [onDirtyChange],
  );

  const refreshList = useCallback(async () => {
    try {
      const res = await listProjectFiles(projectId);
      setFiles(res.files);
      setTotalBytes(res.totalBytes);
      setEngine(res.engine);
      setListState(res.files.length === 0 ? 'empty' : 'ready');
      setListError(null);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.code === 'no_snapshot')) {
        setListState('empty');
        setListError(null);
        return;
      }
      setListState('error');
      setListError(describeApiError(err));
    }
  }, [projectId]);

  // Reload the listing on mount and whenever a new build repoints the preview.
  // biome-ignore lint/correctness/useExhaustiveDependencies: previewUrl is the intended trigger — a new build means new files
  useEffect(() => {
    setListState('loading');
    void refreshList();
  }, [refreshList, previewUrl]);

  const tree = useMemo(() => buildFileTree(files), [files]);
  const selectedEntry = useMemo(
    () => files.find((f) => f.path === selectedPath) ?? null,
    [files, selectedPath],
  );

  return (
    <div className="flex h-full w-full bg-void">
      {/* ── LEFT sidebar (tree). Drawer under md, fixed column md+ ── */}
      <aside
        className={`${treeOpen ? 'flex' : 'hidden'} md:flex w-full md:w-60 md:min-w-[15rem] md:flex-shrink-0 flex-col border-r border-hairline bg-chrome absolute md:relative inset-0 md:inset-auto z-20 md:z-auto`}
      >
        <FileTreeSidebar
          tree={tree}
          files={files}
          totalBytes={totalBytes}
          engine={engine}
          listState={listState}
          listError={listError}
          selectedPath={selectedPath}
          projectId={projectId}
          onSelect={selectFile}
          onRetry={() => {
            setListState('loading');
            void refreshList();
          }}
        />
      </aside>

      {/* ── RIGHT content ── */}
      <section className="flex-1 min-w-0 flex flex-col bg-void">
        {/* Mobile-only "show files" bar */}
        <button
          type="button"
          onClick={() => setTreeOpen(true)}
          className="md:hidden flex-shrink-0 px-4 py-3 text-left text-xs md:py-2 font-mono text-signal border-b border-hairline bg-chrome"
        >
          Files ▸
        </button>

        {selectedEntry ? (
          <FileViewer
            key={selectedEntry.path}
            projectId={projectId}
            entry={selectedEntry}
            isBuilding={isBuilding ?? false}
            onDirtyChange={handleDirtyChange}
            onSaved={() => {
              void refreshList();
              onFileSaved?.();
            }}
          />
        ) : (
          <EmptyViewer state={listState} />
        )}
      </section>
    </div>
  );
}

// ─── Left sidebar ──────────────────────────────────────────────────────────────

interface FileTreeSidebarProps {
  tree: FileNode[];
  files: ProjectFileEntry[];
  totalBytes: number;
  engine: 'phaser' | 'three' | null;
  listState: 'loading' | 'ready' | 'empty' | 'error';
  listError: string | null;
  selectedPath: string | null;
  projectId: string;
  onSelect: (path: string) => void;
  onRetry: () => void;
}

function FileTreeSidebar({
  tree,
  files,
  totalBytes,
  engine,
  listState,
  listError,
  selectedPath,
  projectId,
  onSelect,
  onRetry,
}: FileTreeSidebarProps) {
  return (
    <>
      {/* Overview summary */}
      <div className="flex-shrink-0 px-3 py-3 border-b border-hairline">
        <div className="flex items-center justify-between gap-2">
          <span className="type-label-xs text-ink">Project files</span>
          {engine && (
            <span className="type-label-xs border border-hairline px-2 py-0.5 tracking-[.1em] text-ink-4">
              {engine === 'three' ? 'Three.js 3D' : 'Phaser 2D'}
            </span>
          )}
        </div>
        <p className="mt-1.5 font-mono text-[11px] tracking-[.06em] text-ink-4">
          {listState === 'ready'
            ? `${files.length} ${files.length === 1 ? 'FILE' : 'FILES'} · ${formatBytes(totalBytes).toUpperCase()}`
            : 'The code behind your game'}
        </p>
      </div>

      {/* Tree */}
      <nav className="flex-1 overflow-y-auto scrollbar-thin py-1.5">
        {listState === 'loading' && (
          <div className="px-3 py-4 space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-3.5 bg-raised rounded animate-pulse" />
            ))}
          </div>
        )}
        {listState === 'empty' && (
          <div className="px-3 py-6 text-center">
            <p className="text-[11px] text-ink-4 leading-relaxed">
              Build a game first to see its files here.
            </p>
          </div>
        )}
        {listState === 'error' && (
          <div className="px-3 py-6 text-center">
            <p className="text-[11px] text-fail leading-relaxed">{listError}</p>
            <button
              type="button"
              onClick={onRetry}
              className="mt-2 text-[11px] text-signal hover:text-signal-bright transition-colors"
            >
              Try again
            </button>
          </div>
        )}
        {listState === 'ready' &&
          tree.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
      </nav>

      {/* Download whole project */}
      {listState === 'ready' && (
        <div className="flex-shrink-0 p-2.5 border-t border-hairline">
          <DownloadZipButton projectId={projectId} />
        </div>
      )}
    </>
  );
}

// ─── Tree node (recursive) ───────────────────────────────────────────────────

interface TreeNodeProps {
  node: FileNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

function TreeNode({ node, depth, selectedPath, onSelect }: TreeNodeProps) {
  // Shallow trees → default expanded.
  const [open, setOpen] = useState(true);
  const indent = { paddingLeft: `${8 + depth * 12}px` };

  if (node.type === 'dir') {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          style={indent}
          className="w-full flex items-center gap-1.5 pr-2 py-2.5 px-3 md:py-1 text-left font-mono text-[12px] text-ink-3 hover:bg-surface transition-colors"
        >
          <span className="text-ink-4 w-2.5 inline-block">{open ? '▾' : '▸'}</span>
          <span className="text-ink-4">▤</span>
          <span className="truncate">{node.name}</span>
        </button>
        {open &&
          node.children?.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
      </div>
    );
  }

  const selected = node.path === selectedPath;
  const isEntry = node.path === 'index.html';
  const kind = fileKind(node.path, node.contentType);

  return (
    <button
      type="button"
      onClick={() => onSelect(node.path)}
      style={indent}
      aria-pressed={selected}
      className={`w-full flex items-center gap-1.5 pr-2 py-2.5 px-3 md:py-1 text-left font-mono text-[12px] transition-colors ${
        selected ? 'bg-raised text-ink' : 'text-ink-3 hover:bg-surface hover:text-ink-2'
      }`}
    >
      <span className="w-2.5 inline-block" />
      <KindGlyph kind={kind} />
      <span className="truncate">{node.name}</span>
      {isEntry && (
        <span className="ml-auto flex-shrink-0 font-mono text-[9px] tracking-[.1em] px-1.5 py-0.5 border border-signal text-signal">
          entry
        </span>
      )}
    </button>
  );
}

// File-kind glyphs stay within the brand accent set (signal/live/pass/fail +
// ink steps) so the tree reads as one instrument, not a rainbow.
const KIND_GLYPH: Record<FileKind, { glyph: string; color: string }> = {
  html: { glyph: '◆', color: '#ff5d3b' },
  js: { glyph: '◆', color: '#ffb04d' },
  css: { glyph: '◆', color: '#46e6f0' },
  json: { glyph: '◆', color: '#b6f24a' },
  image: { glyph: '◆', color: '#7ff0f8' },
  audio: { glyph: '◆', color: '#c8ccce' },
  model: { glyph: '◆', color: '#8b9095' },
  other: { glyph: '◇', color: '#5b6165' },
};

function KindGlyph({ kind }: { kind: FileKind }) {
  const { glyph, color } = KIND_GLYPH[kind];
  return (
    <span aria-hidden="true" className="text-[9px] flex-shrink-0" style={{ color }}>
      {glyph}
    </span>
  );
}

// ─── Download .zip button ──────────────────────────────────────────────────────

function DownloadZipButton({ projectId }: { projectId: string }) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    if (downloading) return;
    setDownloading(true);
    setError(null);
    try {
      const blob = await fetchProjectZip(projectId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'game.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => void download()}
        disabled={downloading}
        className="w-full text-xs px-3 py-2.5 md:text-[11px] md:py-2 border border-hairline hover:border-edge text-ink-3 hover:text-ink transition-colors font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
      >
        {downloading ? 'Preparing…' : 'Download your game (.zip)'}
        {!downloading && <span aria-hidden="true">↓</span>}
      </button>
      {error && <p className="mt-1.5 text-[10px] text-fail text-center">{error}</p>}
    </div>
  );
}

// ─── Empty / placeholder viewer ────────────────────────────────────────────────

function EmptyViewer({ state }: { state: 'loading' | 'ready' | 'empty' | 'error' }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 px-8 text-center">
      <div className="w-12 h-12 border border-hairline bg-surface flex items-center justify-center text-ink-4 font-mono text-lg">
        {'<>'}
      </div>
      <p className="text-ink-3 text-sm">
        {state === 'empty'
          ? 'Build a game first to browse its files.'
          : 'Select a file to view its code'}
      </p>
      {state === 'ready' && (
        <p className="text-ink-4 text-xs max-w-xs leading-relaxed">
          index.html is your game&apos;s main file — start there.
        </p>
      )}
    </div>
  );
}

// ─── File viewer / editor ──────────────────────────────────────────────────────

interface FileViewerProps {
  projectId: string;
  entry: ProjectFileEntry;
  onSaved: () => void;
  isBuilding: boolean;
  onDirtyChange: (dirty: boolean) => void;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: ReadProjectFileResponse };

function FileViewer({ projectId, entry, onSaved, isBuilding, onDirtyChange }: FileViewerProps) {
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  const dirty = editing && draft !== savedContent;

  // Avoid setState on an unmounted viewer (user switches files mid-save).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Bubble unsaved state up (for the tree-select + tab-switch guards) and report
  // "clean" on unmount so a stale dirty flag can't block later navigation.
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  // Warn before a full page unload (close tab / hard nav) with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // Load file content whenever the selected entry changes.
  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: 'loading' });
    setEditing(false);
    setSaveError(null);
    void readProjectFile(projectId, entry.path)
      .then((data) => {
        if (cancelled) return;
        setLoad({ kind: 'ready', data });
        const text = data.encoding === 'utf-8' ? (data.content ?? '') : '';
        setDraft(text);
        setSavedContent(text);
      })
      .catch((err) => {
        if (!cancelled) setLoad({ kind: 'error', message: describeApiError(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, entry.path]);

  const save = useCallback(async () => {
    if (saving || isBuilding) return;
    setSaving(true);
    setSaveError(null);
    try {
      await writeProjectFile(projectId, entry.path, draft);
      if (mountedRef.current) {
        setSavedContent(draft);
        setSavedFlash(true);
        setTimeout(() => {
          if (mountedRef.current) setSavedFlash(false);
        }, 1800);
      }
      // Still refresh the preview/list even if this viewer unmounted mid-save.
      onSaved();
    } catch (err) {
      if (mountedRef.current) setSaveError(describeApiError(err));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, [saving, isBuilding, projectId, entry.path, draft, onSaved]);

  // Cmd/Ctrl+S to save while editing & dirty (paused during a build).
  useEffect(() => {
    if (!editing) return;
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (draft !== savedContent && !isBuilding) void save();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, draft, savedContent, isBuilding, save]);

  function guardedExitEdit() {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setDraft(savedContent);
    setEditing(false);
    setSaveError(null);
  }

  const segments = entry.path.split('/');

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Toolbar */}
      <div className="flex-shrink-0 px-3 py-2 border-b border-hairline bg-ground flex items-center gap-3">
        <div className="flex-1 min-w-0 flex items-center gap-1 text-[11px] font-mono truncate">
          {segments.map((seg, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: breadcrumb segments are positional and stable for a given path
            <span key={`${seg}-${i}`} className="flex items-center gap-1">
              {i > 0 && <span className="text-ink-4">/</span>}
              <span className={i === segments.length - 1 ? 'text-ink-2' : 'text-ink-4'}>{seg}</span>
            </span>
          ))}
          {dirty && (
            <span className="ml-1 text-live" title="Unsaved changes" aria-label="Unsaved changes">
              ●
            </span>
          )}
          {savedFlash && (
            <span className="ml-1 text-pass text-[10px] tracking-[.08em]">
              SAVED ✓ · PREVIEW UPDATED
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {load.kind === 'ready' && load.data.encoding === 'utf-8' && !load.data.tooLarge && (
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(load.data.content ?? '')}
              className="text-xs px-3 py-2.5 md:text-[10px] md:px-2 md:py-1 border border-hairline text-ink-3 hover:text-ink hover:border-edge transition-colors font-mono"
            >
              Copy
            </button>
          )}
          <DownloadFileButton entry={entry} data={load.kind === 'ready' ? load.data : null} />
          {entry.isText &&
            load.kind === 'ready' &&
            !load.data.tooLarge &&
            (editing ? (
              <>
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={!dirty || saving || isBuilding}
                  title={isBuilding ? 'Saving is paused while your game is building' : undefined}
                  className="text-xs px-3 py-2.5 md:text-[10px] md:px-2.5 md:py-1 bg-signal text-chrome hover:bg-signal-bright transition-colors font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={guardedExitEdit}
                  className="text-xs px-3 py-2.5 md:text-[10px] md:px-2 md:py-1 border border-hairline text-ink-3 hover:text-ink hover:border-edge transition-colors"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setEditing(true)}
                disabled={isBuilding}
                title={isBuilding ? 'Editing is paused while your game is building' : undefined}
                className="text-xs px-3 py-2.5 md:text-[10px] md:px-2.5 md:py-1 border border-signal text-signal hover:bg-raised transition-colors font-mono disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Edit
              </button>
            ))}
        </div>
      </div>

      {editing && isBuilding && (
        <div className="flex-shrink-0 px-3 py-1.5 text-[11px] text-live bg-live/10 border-b border-live/30">
          Your game is building — saving resumes when it finishes.
        </div>
      )}
      {saveError && (
        <div className="flex-shrink-0 px-3 py-1.5 text-[11px] text-fail bg-fail/10 border-b border-fail/30">
          {saveError}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {load.kind === 'loading' && (
          <div className="h-full flex items-center justify-center text-ink-4 text-sm">Loading…</div>
        )}
        {load.kind === 'error' && (
          <div className="h-full flex items-center justify-center text-fail text-sm px-6 text-center">
            {load.message}
          </div>
        )}
        {load.kind === 'ready' &&
          (editing ? (
            <CodeSurface value={draft} path={entry.path} editable onChange={setDraft} />
          ) : (
            <FileBody entry={entry} data={load.data} />
          ))}
      </div>
    </div>
  );
}

// ─── Read-only body (code / image / binary) ────────────────────────────────────

function FileBody({ entry, data }: { entry: ProjectFileEntry; data: ReadProjectFileResponse }) {
  if (data.tooLarge) {
    return (
      <BinaryNotice
        label={`This file is large (${formatBytes(data.size)}) — download it to view.`}
        entry={entry}
        data={data}
      />
    );
  }

  // SVG is markup, not a raster image. Render its SOURCE (escaped, read-only)
  // rather than as a data: image, so a hostile `<svg onload=…>` asset can never
  // execute in the builder origin — defense-in-depth even though <img> wouldn't
  // run it. (Raster images below render as inline data URLs, which is safe.)
  if (data.contentType === 'image/svg+xml' && data.content !== undefined) {
    return <CodeSurface value={base64ToUtf8(data.content)} path={entry.path} editable={false} />;
  }

  const isImage = data.contentType.startsWith('image/');
  if (isImage && data.content) {
    return (
      <div className="h-full overflow-auto scrollbar-thin flex flex-col items-center justify-center gap-3 p-6 pf-checker">
        {/* A data: URL preview of a generated game asset (not a remote image), so
            next/image is intentionally not used here. */}
        <img
          src={`data:${data.contentType};base64,${data.content}`}
          alt={entry.path}
          className="max-w-full max-h-[70%] object-contain rounded border border-hairline bg-void"
        />
        <p className="text-[11px] text-ink-3 font-mono">
          {entry.path.split('/').pop()} · {formatBytes(data.size)}
        </p>
        <style>
          {
            '.pf-checker{background:#0a0a0a;background-image:linear-gradient(45deg,#141414 25%,transparent 25%),linear-gradient(-45deg,#141414 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#141414 75%),linear-gradient(-45deg,transparent 75%,#141414 75%);background-size:16px 16px;background-position:0 0,0 8px,8px -8px,-8px 0;}'
          }
        </style>
      </div>
    );
  }

  const isAudio = data.contentType.startsWith('audio/');
  if (isAudio && data.content) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 p-6">
        {/* biome-ignore lint/a11y/useMediaCaption: a generated game sound effect has no captions track */}
        <audio controls src={`data:${data.contentType};base64,${data.content}`} className="w-72" />
        <p className="text-[11px] text-ink-3 font-mono">
          {entry.path.split('/').pop()} · {formatBytes(data.size)}
        </p>
      </div>
    );
  }

  if (data.encoding === 'base64' || !entry.isText) {
    return (
      <BinaryNotice label={`Binary file — ${formatBytes(data.size)}`} entry={entry} data={data} />
    );
  }

  return <CodeSurface value={data.content ?? ''} path={entry.path} editable={false} />;
}

function BinaryNotice({
  label,
  entry,
  data,
}: {
  label: string;
  entry: ProjectFileEntry;
  data: ReadProjectFileResponse;
}) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-ink-3 text-sm">{label}</p>
      <DownloadFileButton entry={entry} data={data} />
    </div>
  );
}

// ─── Code surface (syntax-highlighted, line-numbered; read-only OR editable) ──────
//
// Edit mode keeps the code COLORED by overlaying a transparent-text <textarea> on
// the same highlighted <pre> the read-only view uses, scroll-synced so the caret
// lines up with the colored text underneath.

function CodeSurface({
  value,
  path,
  editable,
  onChange,
}: {
  value: string;
  path: string;
  editable: boolean;
  onChange?: (v: string) => void;
}) {
  const lang = useMemo(() => langFromPath(path), [path]);
  const html = useMemo(() => highlightToHtml(value, lang), [value, lang]);
  const lineCount = useMemo(() => value.split('\n').length || 1, [value]);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  // Keep the highlight layer + line-number gutter aligned with the textarea scroll.
  const syncScroll = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    if (preRef.current) {
      preRef.current.scrollTop = ta.scrollTop;
      preRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
  }, []);

  const gutter = (
    <div
      ref={gutterRef}
      aria-hidden="true"
      className="flex-shrink-0 select-none overflow-hidden text-right px-3 py-3 text-ink-4 bg-chrome border-r border-hairline"
    >
      {Array.from({ length: lineCount }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: line numbers are positional and stable
        <div key={i}>{i + 1}</div>
      ))}
    </div>
  );

  if (!editable) {
    return (
      <div className="h-full overflow-auto scrollbar-thin">
        <div className="flex min-w-full font-mono text-[12px] leading-[1.5]">
          <div
            aria-hidden="true"
            className="flex-shrink-0 select-none text-right px-3 py-3 text-ink-4 bg-chrome border-r border-hairline"
          >
            {Array.from({ length: lineCount }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: line numbers are positional and stable
              <div key={i}>{i + 1}</div>
            ))}
          </div>
          <pre className="pf-code flex-1 px-4 py-3 whitespace-pre overflow-visible">
            {/* biome-ignore lint/security/noDangerouslySetInnerHtml: highlightToHtml HTML-escapes all input before adding token spans */}
            <code dangerouslySetInnerHTML={{ __html: html }} />
          </pre>
        </div>
      </div>
    );
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!onChange) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      onChange(`${value.slice(0, start)}  ${value.slice(end)}`);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
    }
  }

  return (
    <div className="h-full flex overflow-hidden font-mono text-[12px] leading-[1.5]">
      {gutter}
      <div className="relative flex-1 overflow-hidden">
        {/* Colored layer (under the textarea). Trailing newline keeps the last
            line from being clipped when scrolled to the bottom. */}
        <pre
          ref={preRef}
          aria-hidden="true"
          className="pf-code pointer-events-none absolute inset-0 m-0 overflow-hidden px-4 py-3 whitespace-pre"
        >
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: highlightToHtml HTML-escapes all input before adding token spans */}
          <code dangerouslySetInnerHTML={{ __html: `${html}\n` }} />
        </pre>
        {/* Transparent-text textarea on top — only caret + selection are visible. */}
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          onScroll={syncScroll}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          aria-label="File content editor"
          className="pf-editor absolute inset-0 resize-none bg-transparent px-4 py-3 whitespace-pre overflow-auto outline-none border-0 scrollbar-thin"
        />
      </div>
    </div>
  );
}

// ─── Single-file download ──────────────────────────────────────────────────────

function DownloadFileButton({
  entry,
  data,
}: {
  entry: ProjectFileEntry;
  data: ReadProjectFileResponse | null;
}) {
  function download() {
    if (!data || data.content === undefined) return;
    const name = entry.path.split('/').pop() ?? 'file';
    let blob: Blob;
    if (data.encoding === 'base64') {
      blob = new Blob([base64ToBytes(data.content)], { type: data.contentType });
    } else {
      blob = new Blob([data.content], { type: data.contentType });
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const disabled = !data || data.content === undefined;
  return (
    <button
      type="button"
      onClick={download}
      disabled={disabled}
      className="text-xs px-3 py-2.5 md:text-[10px] md:px-2 md:py-1 border border-hairline text-ink-3 hover:text-ink hover:border-edge transition-colors font-mono disabled:opacity-40 disabled:cursor-not-allowed"
    >
      Download
    </button>
  );
}

function base64ToBytes(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return buffer;
}

/** Decode base64 file bytes to a UTF-8 string (for showing SVG source safely). */
function base64ToUtf8(b64: string): string {
  return new TextDecoder().decode(base64ToBytes(b64));
}
