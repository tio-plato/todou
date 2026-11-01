import { defineConfig } from "vitest/config";
import { GiB, memoryBoundMaxWorkers } from "../../vitest.workers.ts";

// Peak memory of each test file, the 8 heaviest, rounded up to 0.1 GiB;
// measured 2026-11-01.
const heaviestPeaks = [0.9, 0.2, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1].map(
  (g) => g * GiB,
);

export default defineConfig({
  test: {
    maxWorkers: memoryBoundMaxWorkers("shared", heaviestPeaks),
  },
});
