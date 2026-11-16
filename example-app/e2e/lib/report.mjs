// Collects check results and the comparable snapshot of one run, and writes them as JSON and Markdown.
//
// Status vocabulary: passed · failed · blocked (the environment prevented the check) · not run ·
// unsupported (the platform does not offer the feature).
//
// Check types:
//   baseline      behaviour of the current implementation that a replacement must reproduce, or
//                 change only by a recorded decision
//   known-defect  an existing defect that this run is expected to reproduce; "passed" means it was
//                 observed as recorded, "failed" means the behaviour changed
//   harness       a check of the test harness itself
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createReport({ kind, title }) {
  const checks = [];
  const notes = [];
  const snapshot = {};
  const startedAt = new Date();

  const add = (entry) => {
    checks.push(entry);
    const mark = { passed: 'ok  ', failed: 'FAIL', blocked: 'blkd', 'not run': 'skip', unsupported: 'n/a ' }[entry.status];
    console.log(`  ${mark} ${entry.id} — ${entry.title}${entry.status === 'failed' ? `\n         actual: ${JSON.stringify(entry.actual)}` : ''}`);
  };

  return {
    /** Records a check. `pass` decides passed/failed; `type` defaults to "baseline". */
    check({ id, title, pass, type = 'baseline', expected, actual, ref }) {
      add({ id, title, type, status: pass ? 'passed' : 'failed', expected, actual, ref });
      return pass;
    },
    skip({ id, title, status = 'not run', reason, type = 'baseline' }) {
      add({ id, title, type, status, reason });
    },
    note(text) {
      notes.push(text);
      console.log(`  note ${text}`);
    },
    /** Stores comparable facts under `key`; compared with the recorded snapshot at the end. */
    snap(key, value) {
      snapshot[key] = value;
    },
    snapshot: () => snapshot,
    checks: () => checks,
    failed: () => checks.filter((check) => check.status === 'failed'),

    write(outDir, extra = {}) {
      mkdirSync(outDir, { recursive: true });
      const counts = {};
      for (const check of checks) {
        counts[check.status] = (counts[check.status] ?? 0) + 1;
      }
      const result = {
        kind,
        title,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        counts,
        ...extra,
        notes,
        checks,
        snapshot,
      };
      writeFileSync(join(outDir, 'results.json'), `${JSON.stringify(result, null, 1)}\n`);

      const cell = (value) => (value === undefined ? '' : String(typeof value === 'string' ? value : JSON.stringify(value)).replace(/\|/g, '\\|'));
      const lines = [
        `# ${title}`,
        '',
        `Run: ${result.startedAt} → ${result.finishedAt}`,
        '',
        `Result: ${Object.entries(counts)
          .map(([status, count]) => `${count} ${status}`)
          .join(', ')}`,
        '',
      ];
      for (const [key, value] of Object.entries(extra)) {
        if (typeof value === 'string' || typeof value === 'number') {
          lines.push(`- ${key}: ${value}`);
        }
      }
      lines.push('', '| Status | Type | Check | Title | Observed | Reference |', '|---|---|---|---|---|---|');
      for (const check of checks) {
        lines.push(
          `| ${check.status} | ${check.type} | ${check.id} | ${cell(check.title)} | ${cell(check.actual ?? check.reason)} | ${cell(check.ref)} |`,
        );
      }
      if (notes.length > 0) {
        lines.push('', '## Notes', '', ...notes.map((note) => `- ${note}`));
      }
      writeFileSync(join(outDir, 'summary.md'), `${lines.join('\n')}\n`);
      return result;
    },
  };
}

/** Lists the paths at which two JSON values differ. */
export function diffJson(expected, actual, path = '') {
  if (JSON.stringify(expected) === JSON.stringify(actual)) {
    return [];
  }
  const isObject = (value) => typeof value === 'object' && value !== null;
  if (!isObject(expected) || !isObject(actual) || Array.isArray(expected) !== Array.isArray(actual)) {
    return [{ path: path || '(root)', expected, actual }];
  }
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const differences = [];
  for (const key of keys) {
    differences.push(...diffJson(expected[key], actual[key], path ? `${path}.${key}` : key));
  }
  return differences;
}

/**
 * Compares the run's snapshot with the recorded one, or writes it — only when the caller asks to.
 *
 *   mode 'compare' (default)  Never writes. A missing file is reported as `missing`; the caller must
 *                             treat that as "not compared", never as a pass.
 *   mode 'record'             Creates or replaces the file with this run's snapshot.
 *   mode 'extend'             Adds the top-level keys named in `keys` that the file does not have yet
 *                             and compares everything else. A key the file already has is compared,
 *                             never replaced, and nothing is written if a compared key differs.
 *
 * `blockers` are the reasons this run must not become a fixture (its failed or blocked checks).
 * With any present, 'record' and 'extend' write nothing and report `refused`.
 *
 * @returns {{ mode: 'compared'|'missing'|'recorded'|'extended'|'refused', differences: object[], added?: string[], reason?: string }}
 */
export function compareSnapshot(snapshotPath, current, { mode = 'compare', keys = [], blockers = [] } = {}) {
  const exists = existsSync(snapshotPath);
  const write = (value) => writeFileSync(snapshotPath, `${JSON.stringify(value, null, 1)}\n`);

  if (mode === 'record') {
    if (blockers.length > 0) {
      return { mode: 'refused', differences: [], reason: `the run has failed or blocked checks: ${blockers.join(', ')}` };
    }
    write(current);
    return { mode: 'recorded', differences: [] };
  }

  if (!exists) {
    return { mode: 'missing', differences: [] };
  }
  const recorded = JSON.parse(readFileSync(snapshotPath, 'utf8'));

  if (mode === 'extend') {
    const added = keys.filter((key) => !(key in recorded) && key in current);
    if (added.length > 0) {
      const compared = Object.fromEntries(Object.entries(current).filter(([key]) => !added.includes(key)));
      const differences = diffJson(recorded, compared);
      if (differences.length > 0) {
        return { mode: 'refused', differences, reason: 'keys that are already recorded differ from this run' };
      }
      if (blockers.length > 0) {
        return { mode: 'refused', differences: [], reason: `the run has failed or blocked checks: ${blockers.join(', ')}` };
      }
      // The recorded keys keep their values and their order; the new ones are appended.
      write({ ...recorded, ...Object.fromEntries(added.map((key) => [key, current[key]])) });
      return { mode: 'extended', differences: [], added };
    }
  }

  return { mode: 'compared', differences: diffJson(recorded, current) };
}
