import os from "node:os";

export const GiB = 2 ** 30;

// vitest's forks pool runs each test file in a fresh child process, and with
// no maxWorkers it starts one per core but one. What runs out first is memory,
// not cores: a run that starts more workers than its memory holds gets
// OOM-killed with zero assertion failures to show for it. So each package
// records the peak memory of its heaviest test files, and the worker count is
// the largest n whose n heaviest files fit in the budget together.
//
// The budget is min(cgroup cap, machine's available memory) - 1 GiB:
// - The cap is process.constrainedMemory(), where 0 means unknown and 2^64-1
//   a cgroup with no limit. It reads the process's own cgroup only: a limit
//   set on a parent cgroup alone goes unseen, so put the limit on the cgroup
//   the run starts in. Not process.availableMemory(): in a cgroup that is
//   the cap minus memory.current, which counts the cgroup's own reclaimable
//   page cache. In a 4 GiB scope it fell from 4.27 GB to 2.70 GB after reading
//   a 1.5 GB file while constrainedMemory() stayed put, so a root `pnpm test`,
//   which runs the packages one after another in the same cgroup, would
//   starve the later packages of workers over files the earlier ones read.
// - Available memory is what other processes leave free: os.freemem() on
//   Linux, which is /proc/meminfo's MemAvailable, machine-wide even inside a
//   cgroup. Elsewhere process.availableMemory(): on macOS os.freemem() counts
//   only free pages, while availableMemory() adds inactive and purgeable ones.
// - The 1 GiB is for the vitest main process, pnpm's two processes and the
//   files tests write to tmpfs.
// The worst moment is the n heaviest files peaking at the same time, and it
// is not a rare one: the sequencer starts the slowest or largest files first,
// which tend to be the heaviest. Measured collisions peak below the sum, so
// the count errs on the side of fewer workers.
//
// When a run gets OOM-killed again, re-measure the peaks, not this formula:
// every test file runs in a fork of its own, and its peak is the larger of the
// fork's VmHWM and the summed RSS of the fork and its children, sampled every
// 0.2 s from outside; a temporary setup file logging process.pid and the test
// file's name maps each fork to its file.
const RESERVE = GiB;

const gib = (bytes: number) => (bytes / GiB).toFixed(1);

/**
 * The worker count for a package whose heaviest test files peak at
 * `heaviestPeaks` bytes (any order); files past the last one listed count as
 * the last one. Prints the count and the numbers behind it under vitest,
 * unless VITEST_MAX_WORKERS overrides it.
 */
export function memoryBoundMaxWorkers(
  name: string,
  heaviestPeaks: number[],
): number {
  if (heaviestPeaks.length === 0) {
    throw new Error(`${name}: memoryBoundMaxWorkers needs at least one peak`);
  }
  const peaks = [...heaviestPeaks].sort((a, b) => b - a);
  const constrained = process.constrainedMemory();
  // 2^64-1 reads back as a double past MAX_SAFE_INTEGER.
  const cap =
    constrained > 0 && constrained < Number.MAX_SAFE_INTEGER
      ? constrained
      : undefined;
  const available =
    process.platform === "linux" ? os.freemem() : process.availableMemory();
  const budget = Math.min(cap ?? Number.POSITIVE_INFINITY, available) - RESERVE;
  const ceiling = Math.max(1, os.availableParallelism() - 1);

  let workers = 0;
  let together = 0;
  while (workers < ceiling) {
    const next = together + peaks[Math.min(workers, peaks.length - 1)];
    if (next > budget) break;
    together = next;
    workers++;
  }
  if (workers === 0) {
    workers = 1;
    together = peaks[0];
  }

  // vite dev and vite build read the web config too; only vitest sets VITEST.
  if (process.env.VITEST) {
    if (!process.env.VITEST_MAX_WORKERS) {
      const files =
        workers === 1
          ? `the heaviest test file peaks at ${gib(together)} GiB`
          : `the ${workers} heaviest test files peak at ${gib(together)} GiB together`;
      const spend =
        cap === undefined
          ? `available ${gib(available)} - 1`
          : `min(cgroup cap ${gib(cap)}, available ${gib(available)}) - 1`;
      console.warn(
        `[vitest] ${name}: ${workers} worker${workers === 1 ? "" : "s"}; ${files}, ${gib(budget)} GiB to spend = ${spend}`,
      );
    }
    // Whatever the worker count, a file that alone outgrows the budget
    // dooms the run, so this prints under VITEST_MAX_WORKERS too.
    const heaviest = `the heaviest test file peaks at ${gib(peaks[0])} GiB`;
    if (cap !== undefined && peaks[0] > cap - RESERVE) {
      console.warn(
        `[vitest] ${name}: ${heaviest} but the cgroup cap leaves ${gib(cap - RESERVE)} GiB; expect this run to be OOM-killed`,
      );
    } else if (peaks[0] > available - RESERVE) {
      // The cgroup will not kill it; the machine swaps, and only its own OOM
      // killer steps in at worst.
      console.warn(
        `[vitest] ${name}: ${heaviest} but the machine's available memory leaves ${gib(available - RESERVE)} GiB; expect heavy swapping or an OOM kill`,
      );
    }
  }
  return workers;
}
