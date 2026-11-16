// Tests of the screenshot tracker (e2e/lib/screenshots.mjs). Run with: npm run test:e2e
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createScreenshotTracker } from '../lib/screenshots.mjs';

const PANELS = ['panel-configure', 'panel-live', 'panel-results'];
const OLD = 'png bytes left by an earlier run';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cph-shots-test-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The state a reused output folder is in: every expected screenshot already exists. */
function leaveOldScreenshots() {
  for (const name of PANELS) {
    writeFileSync(join(dir, `${name}.png`), OLD);
  }
}

describe('screenshot tracker', () => {
  it('counts a capture that wrote an image', () => {
    const shots = createScreenshotTracker({ outDir: dir, capture: (file) => writeFileSync(file, 'new image') });

    assert.equal(shots.take('panel-live'), true);

    assert.equal(shots.succeeded('panel-live'), true);
    assert.deepEqual(shots.failures(), {});
  });

  it('does not count a failed capture although a screenshot of an earlier run exists', () => {
    leaveOldScreenshots();
    const shots = createScreenshotTracker({
      outDir: dir,
      capture: () => {
        throw new Error('simctl: Invalid device state\nmore detail');
      },
    });

    for (const name of PANELS) {
      shots.take(name);
    }

    // This is the assertion of the smoke run; it used to pass because the old files were there.
    assert.equal(PANELS.every((name) => shots.succeeded(name)), false);
    assert.deepEqual(shots.failures(), Object.fromEntries(PANELS.map((name) => [name, 'simctl: Invalid device state'])));
    // The old files are gone, so nobody mistakes them for this run's screenshots either.
    assert.equal(PANELS.some((name) => existsSync(join(dir, `${name}.png`))), false);
  });

  it('does not count a capture that reports success without writing an image', () => {
    leaveOldScreenshots();
    const shots = createScreenshotTracker({ outDir: dir, capture: () => undefined });

    assert.equal(shots.take('panel-live'), false);
    assert.match(shots.failures()['panel-live'], /wrote no image/);
  });

  it('does not count a screenshot that was never requested in this run', () => {
    leaveOldScreenshots();
    const shots = createScreenshotTracker({ outDir: dir, capture: (file) => writeFileSync(file, 'new image') });

    shots.take('panel-configure');

    assert.equal(shots.succeeded('panel-configure'), true);
    assert.equal(shots.succeeded('panel-live'), false);
    // An old file the run did not touch is left alone.
    assert.equal(readFileSync(join(dir, 'panel-live.png'), 'utf8'), OLD);
  });

  it('replaces an old screenshot with the new one', () => {
    leaveOldScreenshots();
    const shots = createScreenshotTracker({ outDir: dir, capture: (file) => writeFileSync(file, 'new image') });

    shots.take('panel-results');

    assert.equal(readFileSync(join(dir, 'panel-results.png'), 'utf8'), 'new image');
  });

  it('lets the caller wait for scheduled captures before judging them', async () => {
    const order = [];
    const shots = createScreenshotTracker({
      outDir: dir,
      capture: (file) => {
        order.push('captured');
        writeFileSync(file, 'new image');
      },
    });

    shots.schedule('panel-live', 30);
    shots.schedule('panel-results', 5);
    assert.equal(shots.succeeded('panel-live'), false);

    await shots.settled();
    order.push('judged');

    assert.deepEqual(order, ['captured', 'captured', 'judged']);
    assert.equal(shots.succeeded('panel-live') && shots.succeeded('panel-results'), true);
  });
});
