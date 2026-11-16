// Tests of the snapshot comparison (e2e/lib/report.mjs). Run with: npm run test:e2e
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { compareSnapshot, diffJson } from '../lib/report.mjs';

const RECORDED = { A: { start: { outcome: 'resolved' } }, B: { capture: { outcome: 'resolved', image: { encoded: '640x480' } } } };
const text = (value) => `${JSON.stringify(value, null, 1)}\n`;

let dir;
let file;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cph-report-test-'));
  file = join(dir, 'android-api00-1x1-1dpi.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('compareSnapshot in comparison mode (no flag)', () => {
  it('reports a missing baseline and does not create one', () => {
    const result = compareSnapshot(file, RECORDED);

    assert.equal(result.mode, 'missing');
    assert.deepEqual(result.differences, []);
    assert.equal(existsSync(file), false);
  });

  it('does not create one when called without options either', () => {
    compareSnapshot(file, RECORDED, {});
    compareSnapshot(file, RECORDED, { mode: 'compare', keys: ['A'] });

    assert.equal(existsSync(file), false);
  });

  it('reports no differences for an equal snapshot and leaves the file untouched', () => {
    writeFileSync(file, text(RECORDED));
    const before = statSync(file).mtimeMs;

    const result = compareSnapshot(file, JSON.parse(JSON.stringify(RECORDED)));

    assert.deepEqual(result, { mode: 'compared', differences: [] });
    assert.equal(readFileSync(file, 'utf8'), text(RECORDED));
    assert.equal(statSync(file).mtimeMs, before);
  });

  it('lists what differs and never replaces the baseline with the changed behaviour', () => {
    writeFileSync(file, text(RECORDED));
    const changed = { ...RECORDED, B: { capture: { outcome: 'rejected', error: 'new backend' } } };

    const result = compareSnapshot(file, changed);

    assert.equal(result.mode, 'compared');
    assert.deepEqual(
      result.differences.map((difference) => difference.path).sort(),
      ['B.capture.error', 'B.capture.image', 'B.capture.outcome'],
    );
    assert.equal(readFileSync(file, 'utf8'), text(RECORDED));
  });

  it('reports a case the baseline does not know as a difference', () => {
    writeFileSync(file, text(RECORDED));

    const result = compareSnapshot(file, { ...RECORDED, V: { rect: 1 } });

    assert.deepEqual(result.differences, [{ path: 'V', expected: undefined, actual: { rect: 1 } }]);
    assert.equal(readFileSync(file, 'utf8'), text(RECORDED));
  });
});

describe('compareSnapshot with mode "record"', () => {
  it('creates the baseline', () => {
    assert.deepEqual(compareSnapshot(file, RECORDED, { mode: 'record' }), { mode: 'recorded', differences: [] });
    assert.equal(readFileSync(file, 'utf8'), text(RECORDED));
  });

  it('replaces an existing baseline', () => {
    writeFileSync(file, text({ old: true }));

    compareSnapshot(file, RECORDED, { mode: 'record' });

    assert.equal(readFileSync(file, 'utf8'), text(RECORDED));
  });

  it('refuses when the run has failed or blocked checks, and writes nothing', () => {
    const result = compareSnapshot(file, RECORDED, { mode: 'record', blockers: ['R/app-survives-recording'] });

    assert.equal(result.mode, 'refused');
    assert.match(result.reason, /R\/app-survives-recording/);
    assert.equal(existsSync(file), false);
  });

  it('refuses in the same way over an existing baseline, which stays as it was', () => {
    writeFileSync(file, text(RECORDED));

    const result = compareSnapshot(file, { changed: true }, { mode: 'record', blockers: ['snapshot'] });

    assert.equal(result.mode, 'refused');
    assert.equal(readFileSync(file, 'utf8'), text(RECORDED));
  });
});

describe('compareSnapshot with mode "extend"', () => {
  const NEW_CASE = { rect: { x: 24, y: 96, width: 280, height: 160 } };

  it('appends only the named new case and keeps every recorded byte', () => {
    writeFileSync(file, text(RECORDED));

    const result = compareSnapshot(file, { ...RECORDED, V: NEW_CASE }, { mode: 'extend', keys: ['V'] });

    assert.deepEqual(result, { mode: 'extended', differences: [], added: ['V'] });
    const written = readFileSync(file, 'utf8');
    assert.equal(written, text({ ...RECORDED, V: NEW_CASE }));
    // Everything before the appended key is the old file, byte for byte.
    const oldBody = text(RECORDED).replace(/\n}\n$/, '');
    assert.equal(written.startsWith(`${oldBody},\n`), true);
  });

  it('refuses when a recorded case differs, and writes nothing', () => {
    writeFileSync(file, text(RECORDED));
    const current = { A: { start: { outcome: 'rejected' } }, B: RECORDED.B, V: NEW_CASE };

    const result = compareSnapshot(file, current, { mode: 'extend', keys: ['V'] });

    assert.equal(result.mode, 'refused');
    assert.deepEqual(result.differences.map((difference) => difference.path), ['A.start.outcome']);
    assert.equal(readFileSync(file, 'utf8'), text(RECORDED));
  });

  it('refuses when the run has failed or blocked checks', () => {
    writeFileSync(file, text(RECORDED));

    const result = compareSnapshot(file, { ...RECORDED, V: NEW_CASE }, { mode: 'extend', keys: ['V'], blockers: ['V/rect'] });

    assert.equal(result.mode, 'refused');
    assert.equal(readFileSync(file, 'utf8'), text(RECORDED));
  });

  it('does not add a case that was not named', () => {
    writeFileSync(file, text(RECORDED));

    const result = compareSnapshot(file, { ...RECORDED, V: NEW_CASE, W: { other: true } }, { mode: 'extend', keys: ['V'] });

    assert.equal(result.mode, 'refused');
    assert.deepEqual(result.differences.map((difference) => difference.path), ['W']);
    assert.equal(readFileSync(file, 'utf8'), text(RECORDED));
  });

  it('compares, and never replaces, a named case that is already recorded', () => {
    const recorded = { ...RECORDED, V: NEW_CASE };
    writeFileSync(file, text(recorded));

    const same = compareSnapshot(file, recorded, { mode: 'extend', keys: ['V'] });
    const changed = compareSnapshot(file, { ...RECORDED, V: { rect: null } }, { mode: 'extend', keys: ['V'] });

    assert.deepEqual(same, { mode: 'compared', differences: [] });
    assert.equal(changed.mode, 'compared');
    assert.deepEqual(changed.differences.map((difference) => difference.path), ['V.rect']);
    assert.equal(readFileSync(file, 'utf8'), text(recorded));
  });

  it('needs an existing baseline: a missing one is reported, not created', () => {
    const result = compareSnapshot(file, { ...RECORDED, V: NEW_CASE }, { mode: 'extend', keys: ['V'] });

    assert.equal(result.mode, 'missing');
    assert.equal(existsSync(file), false);
  });
});

describe('diffJson', () => {
  it('finds nothing in equal values', () => {
    assert.deepEqual(diffJson({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), []);
  });

  it('names the path of each difference, including added and removed keys', () => {
    assert.deepEqual(diffJson({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 }, d: 4 }), [
      { path: 'b.c', expected: 2, actual: 3 },
      { path: 'd', expected: undefined, actual: 4 },
    ]);
    assert.deepEqual(diffJson({ a: 1 }, {}), [{ path: 'a', expected: 1, actual: undefined }]);
  });

  it('treats an array and an object as different at their own path', () => {
    assert.deepEqual(diffJson({ a: [] }, { a: {} }), [{ path: 'a', expected: [], actual: {} }]);
  });
});
