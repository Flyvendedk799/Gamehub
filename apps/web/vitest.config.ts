import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Pure-function unit tests only (#16): SSE frame parsing, the y-websocket varint
// codec, chat hydration/coalescing, API-error mapping, and the iframe-bridge
// origin/shape validation. These need no DOM, so we use the default node
// environment and keep the test surface fast. Component tests (jsdom) can be
// layered on later if needed.
export default defineConfig({
  // Mirror the `@/*` → `src/*` path alias from tsconfig. A test that pulls in a
  // component (iframe-bridge.test.ts imports ControlsPanel) resolves whatever
  // that component imports for VALUE — type-only `@/` imports are erased and used
  // to hide the gap, so the first non-type `@/` import in a component broke the
  // suite with "Failed to load url @/lib/...".
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
