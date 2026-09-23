import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    /**
     * One test file at a time.
     *
     * Several suites build a throwaway Postgres with `@electric-sql/pglite`
     * (Postgres 17 as WebAssembly). Two of those instances booting in parallel
     * vitest forks kills a worker outright — `Worker exited unexpectedly`, no
     * assertion failure, a different file each time. Measured on this suite:
     * 2 of 3 parallel runs lost a worker, 3 of 3 sequential runs were green.
     *
     * It is also faster. Parallel: ~19s. Sequential: ~7s. The WASM instances
     * were contending, not sharing. Revisit if the suite grows past a minute;
     * the narrower fix is a separate vitest project for the PGlite files.
     */
    fileParallelism: false,
  },
});
