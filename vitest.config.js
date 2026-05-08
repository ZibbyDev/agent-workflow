import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The abort-deadman + spawn-related tests use real timers and node
    // subprocesses. Default 5s gets squeezed under publish-script CPU
    // load. 30s leaves headroom without masking real hangs.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
