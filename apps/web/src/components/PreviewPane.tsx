'use client';

interface PreviewPaneProps {
  previewUrl: string | null;
  isBuilding: boolean;
  hasError: boolean;
  errorMessage?: string;
}

export function PreviewPane({
  previewUrl,
  isBuilding,
  hasError,
  errorMessage,
}: PreviewPaneProps) {
  return (
    <div className="relative flex flex-col h-full bg-[#0a0a0a]">
      {/* Toolbar */}
      <div className="flex-shrink-0 px-4 py-2 border-b border-[#222222] bg-[#111111] flex items-center gap-3">
        <div className="flex gap-1.5">
          <div className="w-3 h-3 rounded-full bg-[#ef4444]/60" />
          <div className="w-3 h-3 rounded-full bg-[#f59e0b]/60" />
          <div className="w-3 h-3 rounded-full bg-[#22c55e]/60" />
        </div>
        {previewUrl && (
          <span className="flex-1 text-center text-xs font-mono text-[#52525b] truncate">
            preview · {previewUrl.split('/').pop() ?? 'index.html'}
          </span>
        )}
        {!previewUrl && (
          <span className="flex-1 text-center text-xs font-mono text-[#3f3f46]">
            no preview
          </span>
        )}
        {previewUrl && (
          <a
            href={previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-[#6366f1] hover:text-[#818cf8] transition-colors font-mono"
          >
            open ↗
          </a>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 relative overflow-hidden">
        {/* Preview iframe — shown when a URL is available */}
        {previewUrl && !hasError && (
          <iframe
            src={previewUrl}
            title="Game preview"
            sandbox="allow-scripts allow-same-origin"
            className="absolute inset-0 w-full h-full border-0"
          />
        )}

        {/* Building placeholder */}
        {!previewUrl && !hasError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6">
            {isBuilding ? (
              <>
                <BuildingAnimation />
                <div className="text-center">
                  <p className="text-[#f4f4f5] text-sm font-medium">Building your game…</p>
                  <p className="mt-1 text-[#52525b] text-xs">
                    This usually takes 15–60 seconds
                  </p>
                </div>
              </>
            ) : (
              <>
                <IdleGraphic />
                <div className="text-center">
                  <p className="text-[#3f3f46] text-sm">Preview will appear here</p>
                  <p className="mt-1 text-[#2a2a2a] text-xs">
                    Start a build to see your game
                  </p>
                </div>
              </>
            )}
          </div>
        )}

        {/* Error state */}
        {hasError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8">
            <div className="w-12 h-12 rounded-full bg-[#ef4444]/10 border border-[#ef4444]/20 flex items-center justify-center">
              <svg
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M10 6v4M10 14h.01M19 10a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
                  stroke="#ef4444"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <div className="text-center">
              <p className="text-[#ef4444] text-sm font-medium">Build failed</p>
              {errorMessage && (
                <p className="mt-2 text-[#a1a1aa] text-xs font-mono max-w-sm break-all">
                  {errorMessage}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Animations ───────────────────────────────────────────────────────────────

function BuildingAnimation() {
  return (
    <div className="relative w-16 h-16">
      {/* Outer ring */}
      <svg
        className="absolute inset-0 animate-spin"
        style={{ animationDuration: '3s' }}
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <circle
          cx="32"
          cy="32"
          r="28"
          stroke="#6366f1"
          strokeWidth="2"
          strokeDasharray="44 132"
          strokeLinecap="round"
        />
      </svg>
      {/* Inner icon */}
      <div className="absolute inset-0 flex items-center justify-center">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <polygon points="4,3 20,12 4,21" fill="#6366f1" className="opacity-80" />
        </svg>
      </div>
    </div>
  );
}

function IdleGraphic() {
  return (
    <div className="w-16 h-16 rounded-2xl border border-[#1a1a1a] bg-[#111111] flex items-center justify-center">
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <polygon points="5,3 23,14 5,25" fill="#2a2a2a" />
      </svg>
    </div>
  );
}
