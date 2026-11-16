// Takes the named screenshots of one run and remembers which of them were taken in this run.
//
// A check must not pass because a file of that name exists: an output folder is often reused, and a
// screenshot left by an earlier run would then stand in for a capture that failed. Each capture
// therefore removes the file it is about to write, and only a capture that returned without an
// error and left a non-empty file counts as taken.
import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {{ outDir: string, capture: (file: string) => void }} options
 *   `capture` writes a screenshot to `file` and throws when it cannot.
 */
export function createScreenshotTracker({ outDir, capture }) {
  /** name → { ok, file, error? } */
  const results = new Map();
  const pending = [];

  const take = (name) => {
    const file = join(outDir, `${name}.png`);
    const result = { ok: false, file };
    try {
      rmSync(file, { force: true });
      capture(file);
      if (existsSync(file) && statSync(file).size > 0) {
        result.ok = true;
      } else {
        result.error = 'the capture reported no error but wrote no image';
      }
    } catch (error) {
      result.error = String(error?.message ?? error).split('\n')[0];
    }
    results.set(name, result);
    return result.ok;
  };

  return {
    take,
    /** Takes the screenshot `delayMs` from now; `settled()` waits for it. */
    schedule(name, delayMs) {
      pending.push(new Promise((resolve) => setTimeout(() => resolve(take(name)), delayMs)));
    },
    /** Resolves when every scheduled capture has been attempted. */
    settled: () => Promise.all(pending),
    /** True only for a screenshot taken successfully by this tracker. */
    succeeded: (name) => results.get(name)?.ok === true,
    /** name → error text, for every capture that was attempted and failed. */
    failures: () => Object.fromEntries([...results].filter(([, result]) => !result.ok).map(([name, result]) => [name, result.error])),
  };
}
