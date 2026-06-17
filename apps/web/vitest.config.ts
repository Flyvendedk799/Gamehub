import { defineConfig } from 'vitest/config';

// Pure-function unit tests only (#16): SSE frame parsing, the y-websocket varint
// codec, chat hydration/coalescing, API-error mapping, and the iframe-bridge
// origin/shape validation. These need no DOM, so we use the default node
// environment and keep the test surface fast. Component tests (jsdom) can be
// layered on later if needed.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
