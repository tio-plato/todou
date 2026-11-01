import { defineConfig } from "vitest/config";
import { GiB, memoryBoundMaxWorkers } from "../../vitest.workers.ts";

// A fork runs one test file at a time, and a server test file stands up
// several in-memory PGlite (WASM) instances: measured 2026-08-29, the first
// instance costs ~680 MB RSS and each further one ~230 MB. That makes the
// server's files the heaviest of any package: 0.88 GiB at the median,
// 2.16 GiB at p90 and 5.51 GiB for test/projects.test.ts. If a run OOMs
// again, re-measure these peaks (the suite got heavier) the way
// vitest.workers.ts describes, not the formula.
// Peak memory of each test file, the 8 heaviest, rounded up to 0.1 GiB;
// measured 2026-11-01.
const heaviestPeaks = [5.6, 4.7, 3.4, 2.9, 2.8, 2.7, 2.6, 2.5].map(
  (g) => g * GiB,
);

// The 20s timeouts stay even with the worker cap: they defend against other
// agents running their own suites on this shared machine, where PGlite startup
// plus migrations still blow well past the 5s default. A green run pays
// nothing for them, and lowering them reopens exactly the "no assertion
// failed, yet it timed out" flake this cap exists to kill.
export default defineConfig({
  test: {
    maxWorkers: memoryBoundMaxWorkers("server", heaviestPeaks),
    testTimeout: 20_000,
    hookTimeout: 20_000,
    setupFiles: ["./test/setup.ts"],
  },
});
