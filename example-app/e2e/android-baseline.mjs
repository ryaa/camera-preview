// Repeatable Android baseline: drives the installed example app on an emulator or device through its
// automation entry point and records what the plugin's Android implementation does today.
//
//   adb install -r android/app/build/outputs/apk/debug/app-debug.apk
//   node e2e/android-baseline.mjs [--out <dir>] [--only A,B] [--skip T,U] [--port 9222]
//                                 [--record | --extend V,R4] [--accept <check ids>]
//
// The device is chosen like plain adb does (ANDROID_SERIAL, or the only one connected).
//
// Two kinds of result are produced:
//   * checks   — portable statements ("a second start() rejects with …"), each typed as baseline,
//                known-defect or harness (see lib/report.mjs);
//   * snapshot — every outcome, message, image size and EXIF fact of the run, compared with the
//                snapshot recorded for the same device configuration under e2e/baseline/. Timings
//                and payload sizes are never part of it.
//
// A run without --record or --extend only compares and never writes a snapshot: a missing one is
// reported as blocked and the run fails. --record creates or replaces the snapshot; --extend adds
// the named new cases to an existing snapshot and compares everything else. Neither writes when the
// run has failed or blocked checks, except those listed with --accept.
//
// Nothing here knows which camera backend is installed: the same run is the regression oracle for a
// replacement backend.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as device from './lib/adb.mjs';
import { connect } from './lib/cdp.mjs';
import { attachHarness } from './lib/harness-client.mjs';
import { extensionFor, inspectImage, inspectMp4 } from './lib/image-info.mjs';
import { boundingBox, colorVariety, decodePng, isColor, isNotColor } from './lib/png.mjs';
import { compareSnapshot, createReport } from './lib/report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);
const list = (name) => (option(name, '') || '').split(',').filter(Boolean);

const appId =
  option('app-id') ?? readFileSync(join(here, '..', 'capacitor.config.ts'), 'utf8').match(/appId:\s*'([^']+)'/)?.[1];
const outDir = resolve(option('out', join(here, 'out', 'android-baseline')));
const port = Number(option('port', '9222'));
const only = list('only');
const skip = list('skip');
const extend = list('extend');
const accepted = list('accept');
if (flag('record') && extend.length > 0) {
  console.error('android-baseline: --record and --extend exclude each other');
  process.exit(2);
}
const { sleep } = device;

const MAGENTA = [255, 0, 255];
const MAGENTA_CSS = 'rgb(255, 0, 255)';
const FOOTER_DP = 56;
/** The recording limit of cases R2 and R4, and how long they wait for it to pass. */
const MAX_DURATION_MS = 1500;
const MAX_DURATION_WAIT_MS = 4000;
/**
 * Accepted duration of a recording limited to MAX_DURATION_MS: from 0.5 s under the limit (frames
 * are dropped while the encoder starts) to 1 s over it (the recorder notices the limit and
 * finalises the file a little late). The upper bound stays well under MAX_DURATION_WAIT_MS, so a
 * backend that ignores the limit and records until stopRecordVideo() is called cannot pass.
 */
const MAX_DURATION_ACCEPTED_S = [MAX_DURATION_MS / 1000 - 0.5, MAX_DURATION_MS / 1000 + 1];

mkdirSync(outDir, { recursive: true });
const report = createReport({ kind: 'android-baseline', title: 'Example app — Android baseline (current plugin backend)' });
const info = device.deviceInfo();
const deviceKey = `api${info.sdk}-${info.widthPx}x${info.heightPx}-${info.densityDpi}dpi`;
const exercised = new Set();

let page;
let harness;
let environment;
let webViewBox;
/** Screenshot rows on which the system draws over the WebView (status-bar icons, gesture handle). */
let systemBarRows = new Set();
/** Durations of selected calls; reported, never compared. */
const timings = {};

// ------------------------------------------------------------------ app control

async function attach() {
  await device.forwardWebView(appId, port);
  page = await connect(port, { urlPattern: /localhost/ });
  harness = await attachHarness(page);
  await harness.setPolling(false);
  // The run needs no controls; a countdown that stops a preview hiding them must not interfere.
  await harness.setAutoStop(false);
  environment = await harness.environment();
}

async function relaunch() {
  await collectCoverage();
  page?.close();
  device.tryShell(`am force-stop ${appId}`);
  device.removeForward(port);
  device.launch(appId);
  await attach();
}

async function alive() {
  try {
    return (await page.evaluate('1', { timeoutMs: 5000 })) === 1;
  } catch {
    return false;
  }
}

async function collectCoverage() {
  try {
    for (const id of (await harness.coverage()).exercised) {
      exercised.add(id);
    }
  } catch {
    // The page is gone; whatever it had exercised was collected before.
  }
}

// ------------------------------------------------------------------ recording helpers

/** Removes everything that legitimately differs between two runs on the same device. */
function comparable(record, hostImage) {
  const entry = { outcome: record.outcome };
  if (record.error !== undefined) {
    entry.error = record.error;
  }
  if (record.outcome === 'resolved' && record.result !== null && record.result !== undefined) {
    entry.result = JSON.parse(
      JSON.stringify(record.result)
        .replace(/base64\[\d+\]/g, 'base64')
        .replace(/cpcp_capture_[0-9a-f]+/g, 'cpcp_capture_<id>')
        // Recordings are numbered by how many already sit in the cache: videoTmp.mp4, videoTmp_1.mp4, …
        .replace(/videoTmp(_\d+)?\.mp4/g, 'videoTmp<_n>.mp4'),
    );
  }
  if (hostImage) {
    entry.image = {
      kind: record.image?.classification.detected.kind ?? null,
      format: hostImage.format,
      encoded: `${hostImage.encodedWidth}x${hostImage.encodedHeight}`,
      displayed: `${hostImage.displayWidth}x${hostImage.displayHeight}`,
      hasExif: hostImage.hasExif,
      orientation: hostImage.orientation,
    };
  }
  return entry;
}

/** Step labels contain ":" and "/"; artefact file names must not. */
const fileSafe = (label) => label.replace(/[^A-Za-z0-9._-]+/g, '_');

function caseContext(id) {
  const snap = {};
  const artifacts = [];
  const context = {
    id,
    snap,
    /** Issues one plugin call through the harness and records its comparable outcome. */
    async call(label, method, args) {
      const record = await harness.call(method, args);
      let hostImage = null;
      if (record.image) {
        const bytes = await harness.imageBytes(record.id);
        if (bytes) {
          hostImage = inspectImage(bytes);
          const file = `${id}-${fileSafe(label)}.${extensionFor(hostImage.format)}`;
          writeFileSync(join(outDir, file), bytes);
          artifacts.push(file);
          const app = record.image.info;
          report.check({
            id: `${id}/${label}/readers`,
            type: 'harness',
            title: 'In-app and host image readers agree on format, encoded size and EXIF orientation',
            pass:
              !!app &&
              app.format === hostImage.format &&
              app.encodedWidth === hostImage.encodedWidth &&
              app.encodedHeight === hostImage.encodedHeight &&
              (app.jpeg?.orientation ?? null) === hostImage.orientation &&
              (app.jpeg?.hasExif ?? null) === hostImage.hasExif,
            actual: {
              app: app && [app.format, app.encodedWidth, app.encodedHeight, app.jpeg?.orientation ?? null],
              host: [hostImage.format, hostImage.encodedWidth, hostImage.encodedHeight, hostImage.orientation],
            },
          });
        }
      }
      snap[label] = comparable(record, hostImage);
      timings[`${id}/${label}`] = record.durationMs;
      return { record, image: hostImage };
    },
    /** Host screenshot with every harness element hidden; returns the decoded image. */
    async screenshot(name, { backdrop = null } = {}) {
      await harness.setChromeHidden(true);
      await harness.setBackdrop(backdrop);
      await sleep(700);
      const bytes = device.screenshot();
      await harness.setBackdrop(null);
      await harness.setChromeHidden(false);
      const file = `${id}-${fileSafe(name)}.png`;
      writeFileSync(join(outDir, file), bytes);
      artifacts.push(file);
      return decodePng(bytes);
    },
    check: (check) => report.check({ ...check, id: `${id}/${check.id}` }),
    note: (text) => report.note(`${id}: ${text}`),
    artifacts,
  };
  return context;
}

const cases = [];
const defineCase = (id, title, run) => cases.push({ id, title, run });
/** Cases that send the app to the background, or restart it, on purpose. */
const PAUSING_CASES = ['K', 'T', 'U'];

/** CSS pixels (= dp) to screenshot pixels. */
const px = (cssPixels) => Math.round(cssPixels * environment.devicePixelRatio);

/**
 * The screenshot limited to what can be a preview: outside the WebView, and on rows where the
 * system draws its own pixels over an edge-to-edge WebView, every pixel reads as backdrop.
 */
function previewCandidates(image, frame) {
  const { box, rows } = frame;
  return {
    width: image.width,
    height: image.height,
    at: (x, y) => (x < box.left || x > box.right || y < box.top || y > box.bottom || rows.has(y) ? MAGENTA : image.at(x, y)),
  };
}

/**
 * Rectangle of the native preview, in dp relative to the WebView, measured from a backdrop
 * screenshot. `frame` is the calibration of the orientation the screenshot was taken in.
 */
function measuredPreviewRect(image, frame = { box: webViewBox, rows: systemBarRows }) {
  const box = boundingBox(previewCandidates(image, frame), isNotColor(MAGENTA, 24), 2);
  if (!box) {
    return null;
  }
  const scale = environment.devicePixelRatio;
  const round = (value) => Math.round(value * 10) / 10;
  return {
    x: round((box.left - frame.box.left) / scale),
    y: round((box.top - frame.box.top) / scale),
    width: round(box.width / scale),
    height: round(box.height / scale),
  };
}

/**
 * Paints the page one colour and finds the WebView's rectangle in a host screenshot, together with
 * the rows on which the system draws its own pixels over it (status-bar icons, gesture handle).
 */
async function calibrate(file) {
  await harness.setChromeHidden(true);
  await harness.setBackdrop(MAGENTA_CSS);
  await sleep(700);
  const bytes = device.screenshot();
  writeFileSync(join(outDir, file), bytes);
  const image = decodePng(bytes);
  const box = boundingBox(image, isColor(MAGENTA, 24), 2);
  const rows = new Set();
  if (box) {
    const backdrop = isColor(MAGENTA, 24);
    for (let y = box.top; y <= box.bottom; y++) {
      for (let x = box.left; x <= box.right; x += 2) {
        if (!backdrop(image.at(x, y))) {
          rows.add(y);
          break;
        }
      }
    }
  }
  await harness.setBackdrop(null);
  await harness.setChromeHidden(false);
  return { box, rows };
}

/** Turns the display (0 = portrait, 1 = landscape) and waits until the WebView has followed. */
async function rotateTo(rotation) {
  device.shell(`settings put system user_rotation ${rotation}`);
  const wantLandscape = rotation === 1 || rotation === 3;
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(200);
    const size = await page.evaluate('({ width: window.innerWidth, height: window.innerHeight })');
    if (size.width > size.height === wantLandscape) {
      break;
    }
  }
  // The native layout pass and the page's own resize handling follow the WebView's.
  await sleep(1500);
}

/** Distinct colours in the bottom `FOOTER_DP` of the WebView, skipping rows the system draws on. */
function bottomBandVariety(image) {
  let bottom = webViewBox.bottom;
  while (bottom > webViewBox.top && systemBarRows.has(bottom)) {
    bottom--;
  }
  const height = px(FOOTER_DP) - (webViewBox.bottom - bottom);
  const rows = [];
  for (let y = bottom - height + 1; y <= bottom; y++) {
    if (!systemBarRows.has(y)) {
      rows.push(y);
    }
  }
  if (rows.length < 8) {
    return null;
  }
  return colorVariety(image, { left: webViewBox.left, top: rows[0], width: webViewBox.width, height: rows.length });
}

/**
 * Runs a harness call but gives up after `ms`, so a frozen or dead app cannot stall the run. When
 * the app dies the call has no result; whether that shows as a closed connection or as silence is a
 * matter of timing, so both are reported as the one outcome `no-result`.
 */
async function callWithin(ms, method, args) {
  const answer = harness.call(method, args).catch(() => ({ outcome: 'no-result' }));
  return Promise.race([answer, sleep(ms).then(() => ({ outcome: 'no-result' }))]);
}

const REAR = { position: 'rear', toBack: true };
const aspect = (image) => (image ? image.displayWidth / image.displayHeight : null);

// ------------------------------------------------------------------ cases

defineCase('A', 'Rear camera, default options, full screen', async (t) => {
  const before = await t.call('isCameraStarted:before', 'isCameraStarted');
  t.check({
    id: 'not-ready-before-start',
    title: 'isCameraStarted() is false before start()',
    pass: before.record.result?.value === false,
    actual: before.record.result,
  });

  const { start, pendingSamples } = await harness.startWithReadinessProbe(REAR);
  t.snap['start'] = comparable(start);
  t.check({ id: 'start', title: 'start() resolves', pass: start.outcome === 'resolved', actual: start.error ?? start.outcome });
  // Logged for information only: nothing is asserted about these samples, and they are not evidence
  // of when the first frame arrived.
  t.note(`start() took ${start.durationMs} ms; isCameraStarted() while it was pending (logged, not asserted): ${JSON.stringify(pendingSamples)}`);

  const after = await t.call('isCameraStarted:after', 'isCameraStarted');
  t.check({
    id: 'ready-after-start',
    title: 'isCameraStarted() is true as soon as start() has resolved',
    pass: after.record.result?.value === true,
    actual: after.record.result,
  });

  const duplicate = await t.call('start:duplicate', 'start', REAR);
  t.check({
    id: 'duplicate-start',
    title: 'A second start() rejects with "camera already started"',
    pass: duplicate.record.outcome === 'rejected' && duplicate.record.error === 'camera already started',
    actual: duplicate.record.error ?? duplicate.record.outcome,
  });

  const flash = await t.call('getSupportedFlashModes', 'getSupportedFlashModes');
  t.check({
    id: 'flash-modes',
    title: 'getSupportedFlashModes() resolves with a list',
    pass: Array.isArray(flash.record.result?.result),
    actual: flash.record.result,
  });

  const capture = await t.call('capture', 'capture', { quality: 85 });
  t.check({
    id: 'capture-jpeg',
    title: 'capture({ quality: 85 }) returns base64 JPEG data',
    pass: capture.image?.format === 'jpeg' && capture.record.image?.classification.consistent === true,
    actual: capture.record.error ?? capture.record.image?.classification,
  });
  t.check({
    id: 'exif-kept-by-default',
    title: 'With disableExifHeaderStripping omitted the JPEG keeps its EXIF block (runtime default is true; the typings say false)',
    pass: capture.image?.hasExif === true && capture.image?.orientation !== null,
    actual: { hasExif: capture.image?.hasExif, orientation: capture.image?.orientation },
    ref: 'CameraPreview.startCamera reads disableExifHeaderStripping with default true; src/definitions.ts documents false',
  });

  const sample = await t.call('captureSample', 'captureSample', { quality: 85 });
  t.check({
    id: 'sample-jpeg',
    title: 'captureSample({ quality: 85 }) returns base64 JPEG data',
    pass: sample.image?.format === 'jpeg' && sample.record.image?.classification.consistent === true,
    actual: sample.record.error ?? sample.record.image?.classification,
  });

  const screen = await t.screenshot('screen');
  const variety = colorVariety(screen, webViewBox);
  t.check({
    id: 'preview-visible',
    title: 'The preview is visible behind the transparent page (toBack: true)',
    pass: variety >= 8,
    actual: `${variety} distinct colours sampled inside the WebView`,
  });

  const stop = await t.call('stop', 'stop');
  t.check({ id: 'stop', title: 'stop() resolves', pass: stop.record.outcome === 'resolved', actual: stop.record.error });
  const afterStop = await t.call('isCameraStarted:afterStop', 'isCameraStarted');
  t.check({
    id: 'not-ready-after-stop',
    title: 'isCameraStarted() is false after stop()',
    pass: afterStop.record.result?.value === false,
    actual: afterStop.record.result,
  });
  const stopAgain = await t.call('stop:again', 'stop');
  t.check({
    id: 'stop-again',
    title: 'A second stop() rejects with "camera already stopped"',
    pass: stopAgain.record.outcome === 'rejected' && stopAgain.record.error === 'camera already stopped',
    actual: stopAgain.record.error ?? stopAgain.record.outcome,
  });
});

defineCase('B', 'Rear camera, EXIF stripped (disableExifHeaderStripping: false)', async (t) => {
  await t.call('start', 'start', { ...REAR, disableExifHeaderStripping: false });
  const capture = await t.call('capture', 'capture', { quality: 85 });
  t.check({
    id: 'normalised-upright',
    title: 'The capture has no rotating EXIF orientation and its encoded pixels are already portrait',
    pass:
      capture.image !== null &&
      (capture.image.orientation === null || capture.image.orientation === 1) &&
      capture.image.encodedHeight > capture.image.encodedWidth,
    actual: capture.image && { encoded: [capture.image.encodedWidth, capture.image.encodedHeight], orientation: capture.image.orientation },
  });
  await t.call('captureSample', 'captureSample', { quality: 85 });
  await t.call('stop', 'stop');
});

defineCase('C', 'Front camera, default options', async (t) => {
  const start = await t.call('start', 'start', { position: 'front', toBack: true });
  t.check({ id: 'start', title: 'start({ position: "front" }) resolves', pass: start.record.outcome === 'resolved', actual: start.record.error });
  await t.call('getSupportedFlashModes', 'getSupportedFlashModes');
  const capture = await t.call('capture', 'capture', { quality: 85 });
  t.check({
    id: 'front-exif-sideways',
    type: 'known-defect',
    title: 'Front capture in the default (EXIF-preserving) mode displays sideways: landscape pixels with no rotating orientation, on a portrait screen',
    pass: capture.image !== null && capture.image.displayWidth > capture.image.displayHeight,
    actual: capture.image && { displayed: [capture.image.displayWidth, capture.image.displayHeight], orientation: capture.image.orientation },
    ref: 'CameraActivity.configureAndTakePicture: Camera.CameraInfo is constructed but never filled, so the rotation is computed for a rear camera',
  });
  await t.call('captureSample', 'captureSample', { quality: 85 });
  await t.call('stop', 'stop');
});

defineCase('D', 'Front camera, EXIF stripped', async (t) => {
  await t.call('start', 'start', { position: 'front', toBack: true, disableExifHeaderStripping: false });
  const capture = await t.call('capture', 'capture', { quality: 85 });
  t.check({
    id: 'normalised-upright',
    title: 'The normalised front capture is portrait',
    pass: capture.image !== null && capture.image.displayHeight > capture.image.displayWidth,
    actual: capture.image && [capture.image.displayWidth, capture.image.displayHeight],
  });
  await t.call('captureSample', 'captureSample', { quality: 85 });
  await t.call('stop', 'stop');
});

const FOOTER = {
  position: 'rear',
  paddingBottom: FOOTER_DP,
  rotateWhenOrientationChanged: true,
  lockAndroidOrientation: false,
  toBack: true,
  disableAudio: true,
  disableExifHeaderStripping: false,
};
defineCase('E', 'Footer options: paddingBottom without height (the PR #339 option set)', async (t) => {
  await t.call('start', 'start', FOOTER);
  const screen = await t.screenshot('screen');
  const variety = bottomBandVariety(screen);
  t.check({
    id: 'padding-ignored-without-height',
    type: 'known-defect',
    title: `paddingBottom: ${FOOTER_DP} without height has no effect: the bottom ${FOOTER_DP} dp still show the camera image`,
    pass: variety !== null && variety >= 4,
    actual: `${variety} distinct colours in the bottom band`,
    ref: 'CameraPreview.startCamera subtracts paddingBottom only inside the branch that handles an explicit height',
  });
  const capture = await t.call('capture', 'capture', { quality: 85 });
  await t.call('captureSample', 'captureSample', { quality: 85 });
  t.note(`capture displayed ${capture.image?.displayWidth}x${capture.image?.displayHeight}`);
  await t.call('stop', 'stop');
});

defineCase('E2', 'Footer options with an explicit height', async (t) => {
  await t.call('start', 'start', { ...FOOTER, height: environment.viewport.height });
  const screen = await t.screenshot('screen');
  const variety = bottomBandVariety(screen);
  t.check({
    id: 'padding-applied-with-height',
    title: `paddingBottom: ${FOOTER_DP} together with height leaves the bottom ${FOOTER_DP} dp free of camera image`,
    pass: variety !== null && variety <= 2,
    actual: `${variety} distinct colours in the bottom band`,
  });
  await t.call('stop', 'stop');
});

async function rectangleCase(t, rect) {
  const options = { position: 'rear', ...rect, toBack: false, disableExifHeaderStripping: false };
  await t.call('start', 'start', options);
  const screen = await t.screenshot('screen', { backdrop: MAGENTA_CSS });
  const measured = measuredPreviewRect(screen);
  t.snap['measuredRectDp'] = measured;
  const close = (a, b) => Math.abs(a - b) <= 1;
  t.check({
    id: 'preview-rect',
    title: `The native preview occupies the requested rectangle (${rect.width} × ${rect.height} dp at ${rect.x}, ${rect.y}) within 1 dp`,
    pass:
      measured !== null &&
      close(measured.x, rect.x) &&
      close(measured.y, rect.y) &&
      close(measured.width, rect.width) &&
      close(measured.height, rect.height),
    actual: measured,
  });

  const capture = await t.call('capture', 'capture', { quality: 85 });
  const sample = await t.call('captureSample', 'captureSample', { quality: 85 });
  const previewAspect = rect.width / rect.height;
  const delta = (value) => (value === null ? null : Math.round(((value - previewAspect) / previewAspect) * 1000) / 10);
  t.snap['aspectDeltaPercent'] = { capture: delta(aspect(capture.image)), sample: delta(aspect(sample.image)) };
  t.check({
    id: 'capture-aspect-differs',
    type: 'known-defect',
    title: 'capture() does not have the aspect of the visible preview rectangle (difference above 1 %), so it cannot show the same framing',
    pass: capture.image !== null && Math.abs(delta(aspect(capture.image))) > 1,
    actual: { previewAspect: Number(previewAspect.toFixed(4)), captureAspect: aspect(capture.image), deltaPercent: delta(aspect(capture.image)) },
    ref: 'Preview.onLayout fills the rectangle by centre-crop while the picture is the whole sensor frame (upstream issue #275)',
  });
  t.check({
    id: 'sample-aspect-differs',
    type: 'known-defect',
    title: 'captureSample() does not have the aspect of the visible preview rectangle (difference above 1 %)',
    pass: sample.image !== null && Math.abs(delta(aspect(sample.image))) > 1,
    actual: { previewAspect: Number(previewAspect.toFixed(4)), sampleAspect: aspect(sample.image), deltaPercent: delta(aspect(sample.image)) },
    ref: 'Preview.onLayout fills the rectangle by centre-crop while the picture is the whole sensor frame (upstream issue #275)',
  });
  await t.call('stop', 'stop');
}

defineCase('F1', 'Wide rectangle in front of the page (300 × 200 dp)', (t) => rectangleCase(t, { x: 40, y: 120, width: 300, height: 200 }));
defineCase('F2', 'Tall rectangle in front of the page (160 × 280 dp)', (t) => rectangleCase(t, { x: 24, y: 96, width: 160, height: 280 }));

defineCase('G', 'storeToFile: true', async (t) => {
  await t.call('start', 'start', { ...REAR, storeToFile: true });
  const capture = await t.call('capture', 'capture', { quality: 85 });
  const path = capture.record.image?.returnedPath ?? '';
  t.check({
    id: 'capture-file-path',
    title: 'capture() returns a file in the app cache named cpcp_capture_<8 hex>.jpg',
    pass: new RegExp(`^/data/user/\\d+/${appId.replace(/\./g, '\\.')}/cache/cpcp_capture_[0-9a-f]{8}\\.jpg$`).test(path),
    actual: path.replace(/cpcp_capture_[0-9a-f]+/, 'cpcp_capture_<id>'),
  });
  t.check({
    id: 'capture-file-readable',
    title: 'The file is readable through Capacitor.convertFileSrc() and is a JPEG',
    pass: capture.image?.format === 'jpeg' && capture.record.image?.classification.consistent === true,
    actual: capture.record.image?.readError ?? capture.record.image?.classification,
  });
  const sample = await t.call('captureSample', 'captureSample', { quality: 85 });
  t.check({
    id: 'sample-stays-base64',
    title: 'captureSample() still returns base64 with storeToFile: true, and the harness classifies it as base64 (not as a file)',
    pass:
      sample.record.image?.classification.detected.kind === 'base64' &&
      sample.record.image?.classification.expected.kind === 'base64' &&
      sample.record.image?.classification.consistent === true &&
      sample.image?.format === 'jpeg',
    actual: sample.record.image?.classification,
    ref: 'CameraActivity.takeSnapshot always returns base64; storeToFile is read only by the picture path',
  });
  await t.call('stop', 'stop');
});

defineCase('H', 'capture() width and height arguments', async (t) => {
  await t.call('start', 'start', { ...REAR, disableExifHeaderStripping: false });
  const none = await t.call('capture:no-size', 'capture', { quality: 85 });
  const both = await t.call('capture:640x480', 'capture', { quality: 85, width: 640, height: 480 });
  await t.call('capture:width-only', 'capture', { quality: 85, width: 640 });
  await t.call('capture:height-only', 'capture', { quality: 85, height: 480 });
  await t.call('capture:480x640', 'capture', { quality: 85, width: 480, height: 640 });
  await t.call('capture:4000x3000', 'capture', { quality: 85, width: 4000, height: 3000 });
  await t.call('capture:negative-size', 'capture', { quality: 85, width: -1, height: -1 });
  // Quality: what the current backend does at and beyond the documented 0–100 range.
  const q20 = await t.call('capture:quality-20', 'capture', { quality: 20 });
  const q100 = await t.call('capture:quality-100', 'capture', { quality: 100 });
  await t.call('capture:quality-0', 'capture', { quality: 0 });
  await t.call('capture:quality-101', 'capture', { quality: 101 });
  await t.call('capture:quality--1', 'capture', { quality: -1 });
  await t.call('capture:quality-omitted', 'capture', {});
  await t.call('captureSample:quality-20', 'captureSample', { quality: 20 });
  await t.call('captureSample:quality-100', 'captureSample', { quality: 100 });
  t.check({
    id: 'quality-changes-bytes',
    title: 'Consecutive captures in one session honour their own quality: quality 20 is smaller than quality 100',
    pass: q20.image !== null && q100.image !== null && q20.image.byteLength < q100.image.byteLength,
    actual: { bytesAt20: q20.image?.byteLength, bytesAt100: q100.image?.byteLength },
  });
  t.check({
    id: 'default-size-budget',
    title: 'Without width/height the capture stays under the 2048 × 1024-pixel default budget',
    pass: none.image !== null && none.image.encodedWidth * none.image.encodedHeight <= 2048 * 1024,
    actual: none.image && { encoded: [none.image.encodedWidth, none.image.encodedHeight], pixels: none.image.encodedWidth * none.image.encodedHeight },
    ref: 'CameraActivity.getOptimalPictureSize',
  });
  t.check({
    id: 'size-arguments-change-output',
    title: 'width and height change the encoded size (they select a sensor picture size)',
    pass: both.image !== null && none.image !== null && `${both.image.encodedWidth}x${both.image.encodedHeight}` !== `${none.image.encodedWidth}x${none.image.encodedHeight}`,
    actual: both.image && [both.image.encodedWidth, both.image.encodedHeight],
  });
  await t.call('stop', 'stop');
});

defineCase('I', 'position omitted', async (t) => {
  await t.call('start', 'start', { toBack: true });
  const flash = await t.call('getSupportedFlashModes', 'getSupportedFlashModes');
  const capture = await t.call('capture', 'capture', { quality: 85 });
  await t.call('stop', 'stop');
  const rear = report.snapshot()['A'];
  const front = report.snapshot()['C'];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!rear || !front) {
    report.skip({ id: 'I/default-is-rear', title: 'Omitted position selects the rear camera', reason: 'needs cases A and C in the same run' });
    return;
  }
  const signature = { flash: flash.record.result, encoded: capture.image && `${capture.image.encodedWidth}x${capture.image.encodedHeight}` };
  const rearSignature = { flash: rear.getSupportedFlashModes?.result, encoded: rear.capture?.image?.encoded };
  const frontSignature = { flash: front.getSupportedFlashModes?.result, encoded: front.capture?.image?.encoded };
  if (same(rearSignature, frontSignature)) {
    report.skip({ id: 'I/default-is-rear', title: 'Omitted position selects the rear camera', status: 'blocked', reason: 'the two cameras of this device are indistinguishable by flash modes and capture size' });
    return;
  }
  t.check({
    id: 'default-is-rear',
    title: 'Omitted position selects the rear camera (the typings say "front")',
    pass: same(signature, rearSignature),
    actual: signature,
    ref: 'CameraPreview.startCamera treats a missing position as rear; src/definitions.ts documents front',
  });
});

async function opacityCase(t, enableOpacity) {
  await t.call('start', 'start', enableOpacity ? { ...REAR, enableOpacity: true } : REAR);
  const opacity = await t.call('setOpacity', 'setOpacity', { opacity: 0.5 });
  t.check({
    id: 'set-opacity-never-settles',
    type: 'known-defect',
    title: `setOpacity() never settles${enableOpacity ? ' even with enableOpacity: true' : ''}; the harness reports it as unsettled after 3 s`,
    pass: opacity.record.outcome === 'unsettled',
    actual: { outcome: opacity.record.outcome, error: opacity.record.error },
    ref: 'CameraPreview.setOpacity saves the call and never resolves or rejects it',
  });
  if (enableOpacity) {
    await t.screenshot('screen-opacity-0.5');
  }
  const capture = await t.call('capture:after', 'capture', { quality: 85 });
  t.check({
    id: 'usable-afterwards',
    title: 'The preview stays usable after the unsettled setOpacity()',
    pass: capture.record.outcome === 'resolved',
    actual: capture.record.error ?? capture.record.outcome,
  });
  await t.call('stop', 'stop');
}

defineCase('L1', 'setOpacity() without enableOpacity', (t) => opacityCase(t, false));
defineCase('L2', 'setOpacity() with enableOpacity: true', (t) => opacityCase(t, true));

defineCase('M', 'Flash modes', async (t) => {
  await t.call('start', 'start', REAR);
  const flash = await t.call('getSupportedFlashModes', 'getSupportedFlashModes');
  const modes = Array.isArray(flash.record.result?.result) ? flash.record.result.result : [];
  let allResolved = modes.length > 0;
  for (const mode of modes) {
    const set = await t.call(`setFlashMode:${mode}`, 'setFlashMode', { flashMode: mode });
    allResolved &&= set.record.outcome === 'resolved';
  }
  t.check({
    id: 'reported-modes-accepted',
    title: 'setFlashMode() resolves for every mode the camera reports',
    pass: allResolved,
    actual: modes,
  });
  const unknown = await t.call('setFlashMode:strobe', 'setFlashMode', { flashMode: 'strobe' });
  t.check({
    id: 'unknown-mode-rejected',
    title: 'An unknown flash mode rejects with "Flash mode not recognised: strobe"',
    pass: unknown.record.outcome === 'rejected' && unknown.record.error === 'Flash mode not recognised: strobe',
    actual: unknown.record.error ?? unknown.record.outcome,
  });
  await t.call('setFlashMode:off', 'setFlashMode', { flashMode: 'off' });
  await t.call('stop', 'stop');
});

defineCase('N', 'Every start() option sent at once', async (t) => {
  const options = {
    parent: 'ignored-on-android',
    className: 'ignored-on-android',
    x: 0,
    y: 0,
    width: environment.viewport.width,
    height: environment.viewport.height,
    paddingBottom: 0,
    toBack: true,
    position: 'rear',
    rotateWhenOrientationChanged: false,
    lockAndroidOrientation: true,
    storeToFile: false,
    disableExifHeaderStripping: true,
    enableHighResolution: true,
    disableAudio: true,
    enableOpacity: true,
    enableZoom: true,
  };
  const start = await t.call('start', 'start', options);
  t.check({ id: 'start', title: 'start() with all 17 options resolves', pass: start.record.outcome === 'resolved', actual: start.record.error });
  const capture = await t.call('capture', 'capture', { quality: 85 });
  t.check({ id: 'capture', title: 'capture() works in that session', pass: capture.image?.format === 'jpeg', actual: capture.record.error });
  await t.call('stop', 'stop');
});

defineCase('P', 'Fractional width (200.5 dp)', async (t) => {
  await t.call('start', 'start', { position: 'rear', x: 20, y: 60, width: 200.5, height: 300, toBack: false });
  const screen = await t.screenshot('screen', { backdrop: MAGENTA_CSS });
  const measured = measuredPreviewRect(screen);
  t.snap['measuredRectDp'] = measured;
  t.check({
    id: 'fractional-width-treated-as-omitted',
    type: 'known-defect',
    title: 'A fractional width is silently treated as omitted: the preview is not 200.5 dp wide but spans to the screen edge',
    pass: measured !== null && measured.width > 250,
    actual: measured,
    ref: 'PluginCall.getInt returns the default for a number that is not an integer, so width reads as 0',
  });
  await t.call('stop', 'stop');
});

const LAB_ORDER = [
  'duplicate-start',
  'overlapping-capture',
  'overlapping-sample',
  'capture-with-sample',
  'rapid-flip',
  'stop-during-capture',
  'start-stop-race',
  'start-stop-cycles',
  'no-session',
];

/**
 * The current backend has two spellings of one rejection ("Camera preview is not ready" in
 * CameraPreview.java, "camera preview is not ready" in CaptureCoordinator), and which of them a
 * racing call receives depends on timing. In the concurrency lab they are recorded as one message;
 * everywhere else messages are compared exactly.
 */
const raceMessage = (error) => (/^camera preview is not ready$/i.test(error ?? '') ? 'camera preview is not ready' : (error ?? null));

defineCase('J', 'Concurrency lab', async (t) => {
  for (const scenario of LAB_ORDER) {
    const result = await harness.runScenario(scenario, { start: REAR, cycles: 5 });
    t.snap[scenario] = {
      groups: result.groups.map((group) => ({
        name: group.name,
        calls: group.calls.map((call) => ({ label: call.label, outcome: call.outcome, error: raceMessage(call.error) })),
      })),
      checks: result.checks,
    };
    t.check({
      // What a run can observe is that no promise stays pending. Whether the native side tried to
      // settle a call twice is invisible from JavaScript; the plugin's coordinator and router unit
      // tests are the evidence for that.
      id: `${scenario}/settled`,
      title: `Lab "${scenario}": no call is left unsettled within its deadline`,
      pass: result.unsettled === 0,
      actual: result.groups.flatMap((group) => group.calls.filter((call) => call.outcome === 'unsettled').map((call) => `${group.name}/${call.label}`)),
    });
  }
  await harness.reset();
});

defineCase('K', 'Background and resume', async (t) => {
  await t.call('start', 'start', REAR);
  device.shell('input keyevent KEYCODE_HOME');
  await sleep(1500);
  const hidden = await harness.sampleReadiness(4, 400);
  t.snap['backgrounded'] = hidden.map((sample) => sample.value);
  t.check({
    id: 'not-ready-while-backgrounded',
    title: 'isCameraStarted() is false while the app is in the background',
    pass: hidden.length > 0 && hidden.every((sample) => sample.value === false),
    actual: hidden.map((sample) => sample.value),
  });
  const pausedCapture = await t.call('capture:backgrounded', 'capture', { quality: 85 });
  t.note(`capture while backgrounded: ${pausedCapture.record.outcome} ${pausedCapture.record.error ?? ''}`);

  device.launch(appId);
  const resumed = await harness.sampleReadiness(10, 250);
  const firstTrue = resumed.find((sample) => sample.value === true);
  t.check({
    id: 'ready-again-after-resume',
    title: 'Readiness returns to true after resume without another start()',
    pass: firstTrue !== undefined,
    actual: firstTrue ? `true after ${firstTrue.atMs} ms` : resumed.map((sample) => sample.value),
  });
  const capture = await t.call('capture:resumed', 'capture', { quality: 85 });
  t.check({
    id: 'capture-after-resume',
    title: 'capture() works after resume',
    pass: capture.image?.format === 'jpeg',
    actual: capture.record.error ?? capture.record.outcome,
  });
  await t.call('stop', 'stop');
});

defineCase('S', 'Landscape (device rotated)', async (t) => {
  device.shell('settings put system accelerometer_rotation 0');
  device.shell('settings put system user_rotation 1');
  await sleep(2500);
  try {
    const viewport = await page.evaluate('({ width: window.innerWidth, height: window.innerHeight })');
    t.check({
      id: 'webview-rotated',
      type: 'harness',
      title: 'The WebView is in landscape after the rotation',
      pass: viewport.width > viewport.height,
      actual: viewport,
    });
    await t.call('start', 'start', REAR);
    await t.call('capture:exif-kept', 'capture', { quality: 85 });
    await t.call('captureSample', 'captureSample', { quality: 85 });
    await t.screenshot('screen');
    await t.call('stop', 'stop');
    await t.call('start:exif-stripped', 'start', { ...REAR, disableExifHeaderStripping: false });
    const stripped = await t.call('capture:exif-stripped', 'capture', { quality: 85 });
    t.check({
      id: 'normalised-landscape',
      title: 'In landscape the normalised capture is landscape',
      pass: stripped.image !== null && stripped.image.displayWidth > stripped.image.displayHeight,
      actual: stripped.image && [stripped.image.displayWidth, stripped.image.displayHeight],
    });
    await t.call('stop', 'stop');
  } finally {
    device.shell('settings put system user_rotation 0');
    await sleep(2500);
  }
});

async function pullVideo(t, label, record) {
  const path = record.video?.path ?? null;
  if (!path) {
    return null;
  }
  const bytes = device.readAppFile(appId, path);
  const file = `${t.id}-${fileSafe(label)}.mp4`;
  writeFileSync(join(outDir, file), bytes);
  t.artifacts.push(file);
  const video = inspectMp4(bytes);
  t.snap[`${label}:container`] = { isMp4: video.isMp4, tracks: video.tracks.slice().sort() };
  t.note(`${label}: ${bytes.length} bytes, duration ${video.durationSeconds?.toFixed(2)} s, tracks ${video.tracks.join('+')}`);
  return video;
}

/** Like pullVideo, but a failure to retrieve or read the file is reported instead of thrown. */
async function tryPullVideo(t, label, record) {
  if (!record.video?.path) {
    return { video: null, problem: `no file path in the result: ${JSON.stringify(record.error ?? record.result ?? record.outcome)}` };
  }
  try {
    return { video: await pullVideo(t, label, record), problem: null };
  } catch (error) {
    return { video: null, problem: `could not read ${record.video.path}: ${String(error.message ?? error).split('\n')[0]}` };
  }
}

defineCase('R', 'Video recording with the microphone permission granted', async (t) => {
  await t.call('start', 'start', REAR);
  const idleStop = await t.call('stopRecordVideo:nothing-recording', 'stopRecordVideo');
  t.check({
    id: 'stop-with-nothing-recording',
    title: 'stopRecordVideo() with nothing recording rejects (with the text of an internal exception)',
    pass: idleStop.record.outcome === 'rejected',
    actual: { outcome: idleStop.record.outcome, error: idleStop.record.error },
  });
  const begin = await t.call('startRecordVideo', 'startRecordVideo', {});
  t.check({
    id: 'start-resolves-immediately',
    title: 'startRecordVideo() resolves (it does so before the recorder has started, so a start failure cannot reject it)',
    pass: begin.record.outcome === 'resolved',
    actual: { outcome: begin.record.outcome, error: begin.record.error, ms: begin.record.durationMs },
    ref: 'CameraPreview.startRecordVideo calls call.resolve() right after posting the start to the UI thread',
  });
  await sleep(3000);
  // A recording can take the whole process down without a Java exception (seen once on an API 36
  // emulator). Say so explicitly instead of failing on a closed connection.
  const survived = device.isAppRunning(appId) && (await alive());
  t.check({
    id: 'app-survives-recording',
    title: 'The app is still running 3 s into the recording',
    pass: survived,
    actual: survived ? 'running' : 'the app process terminated while recording',
  });
  if (!survived) {
    t.snap['recording'] = { appSurvived: false };
    for (const id of ['stop-returns-path', 'file-is-playable-container', 'capture-after-recording']) {
      report.skip({ id: `R/${id}`, title: 'Not reached', status: 'blocked', reason: 'the app process terminated while recording' });
    }
    return;
  }
  const end = await t.call('stopRecordVideo', 'stopRecordVideo');
  t.check({
    id: 'stop-returns-path',
    title: 'stopRecordVideo() resolves { videoFilePath } (the typings declare void)',
    pass: end.record.outcome === 'resolved' && typeof end.record.video?.path === 'string',
    actual: end.record.error ?? end.record.result,
    ref: 'CameraPreview.onStopRecordVideo resolves { videoFilePath }; src/definitions.ts declares Promise<void>',
  });
  const video = await pullVideo(t, 'recording', end.record);
  t.check({
    id: 'file-is-playable-container',
    title: 'The file is an MP4 with a video track, an audio track, and a duration near the 3 s recorded',
    pass:
      video !== null &&
      video.isMp4 &&
      video.tracks.includes('vide') &&
      video.tracks.includes('soun') &&
      video.durationSeconds > 1.5 &&
      video.durationSeconds < 6,
    actual: video,
  });
  const capture = await t.call('capture:after-recording', 'capture', { quality: 85 });
  t.check({
    id: 'capture-after-recording',
    title: 'capture() works after a recording',
    pass: capture.record.outcome === 'resolved',
    actual: capture.record.error ?? capture.record.outcome,
  });
  await t.call('stop', 'stop');
});

defineCase('R2', 'Recording options: withFlash and maxDuration', async (t) => {
  await t.call('start', 'start', REAR);
  const begin = await t.call('startRecordVideo', 'startRecordVideo', {
    position: 'rear',
    width: 640,
    height: 480,
    withFlash: true,
    maxDuration: MAX_DURATION_MS,
  });
  t.check({
    id: 'start-resolves',
    title: `startRecordVideo({ maxDuration: ${MAX_DURATION_MS}, withFlash: true, … }) resolves`,
    pass: begin.record.outcome === 'resolved',
    actual: { outcome: begin.record.outcome, error: begin.record.error },
  });
  // Wait well past the limit before asking for the file, so the limit — not the stop — ends it.
  await sleep(MAX_DURATION_WAIT_MS);
  const survived = device.isAppRunning(appId) && (await alive());
  t.check({
    id: 'app-survives-recording',
    title: `The app is still running ${MAX_DURATION_WAIT_MS / 1000} s after the limited recording started`,
    pass: survived,
    actual: survived ? 'running' : 'the app process terminated',
  });
  if (!survived) {
    t.snap['recording'] = { appSurvived: false };
    for (const id of ['stop-returns-path', 'file-is-readable', 'max-duration-honoured']) {
      report.skip({ id: `R2/${id}`, title: 'Not reached', status: 'blocked', reason: 'the app process terminated while recording' });
    }
    return;
  }
  const end = await t.call('stopRecordVideo', 'stopRecordVideo');
  t.check({
    id: 'stop-returns-path',
    title: 'stopRecordVideo() after the limit has passed still resolves { videoFilePath }',
    pass: end.record.outcome === 'resolved' && typeof end.record.video?.path === 'string',
    actual: end.record.error ?? end.record.result,
  });
  const { video, problem } = await tryPullVideo(t, 'recording', end.record);
  t.check({
    id: 'file-is-readable',
    title: 'The limited recording can be retrieved and is an MP4 with a video track',
    pass: video !== null && video.isMp4 && video.tracks.includes('vide'),
    actual: problem ?? video,
  });
  const [shortest, longest] = MAX_DURATION_ACCEPTED_S;
  const seconds = video?.durationSeconds ?? null;
  t.check({
    id: 'max-duration-honoured',
    title:
      `maxDuration: ${MAX_DURATION_MS} ends the recording by itself: the file lasts between ${shortest} and ${longest} s ` +
      `although stopRecordVideo() was called only after ${MAX_DURATION_WAIT_MS / 1000} s`,
    pass: seconds !== null && seconds >= shortest && seconds <= longest,
    actual: problem ?? { durationSeconds: seconds === null ? null : Math.round(seconds * 100) / 100, acceptedSeconds: MAX_DURATION_ACCEPTED_S },
    ref: 'CameraActivity.startRecord passes maxDuration to MediaRecorder.setMaxDuration',
  });
  await t.call('stop', 'stop');
});

/**
 * Issues one call while a recording is in its `afterMs`-th millisecond and records what the call
 * answered and whether the app survived. Each call gets a recording of its own, so one that freezes
 * or kills the app cannot hide the others.
 */
async function callDuringRecording(t, [label, method, args], { recordArgs = {}, afterMs = 1200 } = {}) {
  if (!(await alive())) {
    await relaunch();
  }
  await harness.call('start', REAR);
  await harness.call('startRecordVideo', recordArgs);
  await sleep(afterMs);
  const answer = await callWithin(30_000, method, args);
  await sleep(800);
  const survived = device.isAppRunning(appId) && (await alive());
  // If the app died, what the call managed to answer first is a race and is not recorded.
  const observed = { outcome: survived ? answer.outcome : 'app-terminated', appSurvived: survived };
  if (survived && answer.error !== undefined && answer.outcome === 'rejected') {
    observed.error = answer.error;
  }
  if (survived) {
    const finish = await callWithin(30_000, 'stopRecordVideo');
    observed.stopRecordVideoAfterwards = finish.outcome === 'rejected' ? `rejected: ${finish.error}` : finish.outcome;
    const stillAlive = device.isAppRunning(appId) && (await alive());
    observed.appSurvivedStopRecordVideo = stillAlive;
    if (stillAlive) {
      await harness.reset();
    }
  }
  t.snap[label] = observed;
  if (!(device.isAppRunning(appId) && (await alive()))) {
    device.tryShell(`am force-stop ${appId}`);
    await relaunch();
  }
  return observed;
}

defineCase('R3', 'Calls issued during a recording', async (t) => {
  const interruptions = [
    ['second-startRecordVideo', 'startRecordVideo', {}],
    ['capture', 'capture', { quality: 85 }],
    ['captureSample', 'captureSample', { quality: 85 }],
    ['flip', 'flip', undefined],
    ['stop', 'stop', undefined],
  ];
  for (const interruption of interruptions) {
    const observed = await callDuringRecording(t, interruption);
    t.note(`${interruption[0]} during a recording: ${JSON.stringify(observed)}`);
  }
  t.check({
    id: 'observed',
    type: 'harness',
    title: 'Every interruption was observed (an answer or its absence, and whether the app survived)',
    pass: Object.keys(t.snap).length === interruptions.length,
    actual: t.snap,
  });
});

defineCase('T', 'Camera permission denied, then granted', async (t) => {
  device.shell(`pm revoke ${appId} android.permission.CAMERA`);
  // After two denials Android stops showing the prompt and denies silently; clear that memory so
  // the prompt appears on every run. Either way the plugin must reject with the same message.
  device.tryShell(`pm clear-permission-flags ${appId} android.permission.CAMERA user-set user-fixed`);
  await sleep(500);
  await relaunch();
  const pending = harness.call('start', REAR);
  let settled = false;
  void pending.then(() => (settled = true));
  let tapped = null;
  for (let attempt = 0; attempt < 10 && tapped === null && !settled; attempt++) {
    await sleep(700);
    tapped = settled ? null : device.tapByText(/^(Don.t allow|Deny)$/i);
  }
  const denied = await pending;
  t.snap['start:denied'] = comparable(denied);
  t.note(tapped === null ? 'no permission prompt appeared; the system denied silently' : `permission prompt answered with "${tapped}"`);
  t.check({
    id: 'denied-rejects',
    title: 'A denied camera permission rejects start() with "Permission failed: user denied access to camera."',
    pass: denied.outcome === 'rejected' && denied.error === 'Permission failed: user denied access to camera.',
    actual: { promptAnswered: tapped, outcome: denied.outcome, error: denied.error },
  });
  await harness.reset();
  device.shell(`pm grant ${appId} android.permission.CAMERA`);
  await sleep(500);
  if (!(await alive())) {
    await relaunch();
  }
  const granted = await t.call('start:granted', 'start', REAR);
  t.check({
    id: 'granted-starts',
    title: 'After the permission is granted start() resolves',
    pass: granted.record.outcome === 'resolved',
    actual: granted.record.error ?? granted.record.outcome,
  });
  await t.call('stop', 'stop');
});

defineCase('U', 'Recording without the microphone permission', async (t) => {
  device.shell(`pm revoke ${appId} android.permission.RECORD_AUDIO`);
  await sleep(500);
  await relaunch();
  await t.call('start', 'start', REAR);
  const begin = await callWithin(8000, 'startRecordVideo', {});
  await sleep(1500);
  const running = device.isAppRunning(appId) && (await alive());
  // The promise may resolve just before the process dies; only the survival of the app is recorded.
  t.snap['startRecordVideo'] = { appSurvived: running };
  t.check({
    id: 'crashes-without-microphone',
    type: 'known-defect',
    title: 'startRecordVideo() without RECORD_AUDIO terminates the app process (uncaught exception from MediaRecorder.setAudioSource)',
    pass: !running,
    actual: { startRecordVideo: begin.outcome, appSurvived: running },
    ref: 'CameraActivity.startRecord sets an audio source unconditionally; the plugin neither declares nor requests RECORD_AUDIO',
  });
  device.tryShell(`pm grant ${appId} android.permission.RECORD_AUDIO`);
  await relaunch();
});

/**
 * What the next call answers once a recording has run into its maxDuration, before anyone called
 * stopRecordVideo(). A backend that finalises such a recording by itself has to leave the session
 * usable for exactly these calls; this is the record of what the current backend does.
 */
defineCase('R4', 'Calls issued after a recording reached maxDuration', async (t) => {
  const followUps = [
    ['captureSample', 'captureSample', { quality: 85 }],
    ['capture', 'capture', { quality: 85 }],
  ];
  for (const followUp of followUps) {
    const observed = await callDuringRecording(t, followUp, {
      recordArgs: { maxDuration: MAX_DURATION_MS },
      afterMs: MAX_DURATION_WAIT_MS,
    });
    t.note(`${followUp[0]} after maxDuration passed: ${JSON.stringify(observed)}`);
  }
  t.check({
    id: 'observed',
    type: 'harness',
    title: 'Each follow-up call was observed (an answer or its absence, and whether the app survived)',
    pass: Object.keys(t.snap).length === followUps.length,
    actual: t.snap,
  });
});

/** The part of `rect` that lies inside a viewport of the given size; `null` when nothing does. */
function clipToViewport(rect, viewport) {
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(viewport.width, rect.x + rect.width);
  const bottom = Math.min(viewport.height, rect.y + rect.height);
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

const sameRect = (a, b, tolerance = 1) =>
  a !== null && b !== null && ['x', 'y', 'width', 'height'].every((key) => Math.abs(a[key] - b[key]) <= tolerance);

/**
 * Turns the device while a preview is running and measures, after each turn, where the native view
 * is. The measurement is the Camera1 record for a replacement backend; the comparison with the
 * rectangle the harness expects checks that the harness guide follows a rotation the way the native
 * view does (its capture diagnostics and control placement are derived from that rectangle).
 */
defineCase('V', 'Device turned while a preview is running', async (t) => {
  device.shell('settings put system accelerometer_rotation 0');
  const portrait = { box: webViewBox, rows: systemBarRows };
  let landscape = null;
  try {
    // Calibrate landscape with nothing running: where the WebView is and where the system draws.
    await rotateTo(1);
    landscape = await calibrate('V-calibration-landscape.png');
    const viewport = await page.evaluate('({ width: window.innerWidth, height: window.innerHeight })');
    t.check({
      id: 'webview-rotated',
      type: 'harness',
      title: 'The WebView is in landscape after the rotation and was located in a host screenshot',
      pass: viewport.width > viewport.height && landscape.box !== null && Math.abs(landscape.box.width - px(viewport.width)) <= 2,
      actual: { viewport, box: landscape.box, rowsWithSystemPixels: landscape.rows.size },
    });
    await rotateTo(0);
    if (!landscape.box) {
      throw new Error('landscape calibration failed: no backdrop found in the screenshot');
    }

    const previews = [
      ['full-screen', {}],
      ['tall', { x: 24, y: 96, width: 160, height: 280 }],
      ['wide', { x: 40, y: 120, width: 300, height: 200 }],
    ];
    const turns = [
      ['portrait', null, portrait],
      ['landscape', 1, landscape],
      ['portrait-again', 0, portrait],
    ];
    for (const [name, rect] of previews) {
      await t.call(`${name}:start`, 'start', { position: 'rear', ...rect, toBack: false, disableExifHeaderStripping: false });
      const observed = {};
      for (const [state, rotation, frame] of turns) {
        // The turn to landscape leaves the wide rectangle as it is but takes away the room for the
        // controls. For this one step the automatic stop is allowed, as it is for a person at the
        // device, to see that the harness arms it although the rectangle did not change.
        const watchRecovery = name === 'wide' && state === 'landscape';
        if (watchRecovery) {
          await harness.setAutoStop(true);
        }
        if (rotation !== null) {
          await rotateTo(rotation);
        }
        const expected = await harness.preview();
        if (watchRecovery) {
          await harness.setAutoStop(false);
          const afterwards = await harness.preview();
          t.check({
            id: `${name}/${state}/control-recovery-armed`,
            type: 'harness',
            title: `${name}, ${state}: the unchanged rectangle leaves no band for the controls, and the automatic stop is armed (and cancelled when turned off again)`,
            pass: expected.controlBand === null && typeof expected.autoStopIn === 'number' && expected.autoStopIn > 0 && afterwards.autoStopIn === null,
            actual: { rect: expected.rect, controlBand: expected.controlBand, autoStopIn: expected.autoStopIn, afterTurningItOff: afterwards.autoStopIn },
          });
        }
        const viewport = await page.evaluate('({ width: window.innerWidth, height: window.innerHeight })');
        const screen = await t.screenshot(`${name}-${state}`, { backdrop: MAGENTA_CSS });
        const measured = measuredPreviewRect(screen, frame);
        // Only what lies inside the WebView can be seen in a screenshot.
        const visible = expected.rect && clipToViewport(expected.rect, viewport);
        observed[state] = { measuredRectDp: measured };
        t.check({
          id: `${name}/${state}/harness-follows-native`,
          type: 'harness',
          title: `${name}, ${state}: the rectangle the harness expects is where the native preview is, within 1 dp`,
          pass: sameRect(measured, visible),
          actual: { measured, harnessExpects: expected.rect, visiblePart: visible, source: expected.source, viewport },
        });
        if (state === 'landscape') {
          const capture = await t.call(`${name}:capture-landscape`, 'capture', { quality: 85 });
          t.check({
            id: `${name}/landscape/capture-compared-with-turned-rect`,
            type: 'harness',
            title: `${name}: a capture taken in landscape is compared with the turned rectangle, not with the one of start()`,
            pass: capture.record.image != null && JSON.stringify(capture.record.image.previewRect) === JSON.stringify(expected.rect),
            actual: { previewRectOfCapture: capture.record.image?.previewRect ?? null, harnessExpects: expected.rect },
          });
        }
      }
      t.snap[name] = observed;
      await t.call(`${name}:stop`, 'stop');
      if (name === 'wide') {
        const back = observed['portrait-again'].measuredRectDp;
        t.check({
          id: 'wide/round-trip-exchanges-sides',
          type: 'known-defect',
          title: `A wide rectangle does not survive a turn to landscape and back: its ${rect.width} × ${rect.height} dp come back as ${rect.height} × ${rect.width}`,
          pass: sameRect(back, { x: rect.x, y: rect.y, width: rect.height, height: rect.width }),
          actual: { started: rect, afterRoundTrip: back },
          ref: 'CameraActivity.onConfigurationChanged exchanges width and height whenever the container shape (taller than wide or not) differs from the new orientation; it does not remember the size of start()',
        });
      }
    }
  } finally {
    await rotateTo(0);
  }
});

// ------------------------------------------------------------------ run

console.log(`android-baseline: ${info.model} · API ${info.sdk} · ${info.widthPx}x${info.heightPx} @ ${info.densityDpi} dpi · ${appId}`);

let exitCode = 1;
try {
  device.tryShell(`pm grant ${appId} android.permission.CAMERA`);
  device.tryShell(`pm grant ${appId} android.permission.RECORD_AUDIO`);
  device.tryShell('settings put system accelerometer_rotation 0');
  device.tryShell('settings put system user_rotation 0');
  device.tryShell('logcat -c');
  await relaunch();

  // Calibration: paint the page one colour and find the WebView's rectangle on screen.
  const calibration = await calibrate('calibration.png');
  webViewBox = calibration.box;
  systemBarRows = calibration.rows;
  report.check({
    id: 'calibration',
    type: 'harness',
    title: 'The WebView rectangle was located in a host screenshot',
    pass: webViewBox !== null && Math.abs(webViewBox.width - px(environment.viewport.width)) <= 2,
    actual: { ...webViewBox, rowsWithSystemPixels: systemBarRows.size },
  });
  if (!webViewBox) {
    throw new Error('calibration failed: no backdrop found in the screenshot');
  }

  for (const testCase of cases) {
    if ((only.length > 0 && !only.includes(testCase.id)) || skip.includes(testCase.id)) {
      report.skip({ id: testCase.id, title: testCase.title, reason: 'deselected on the command line' });
      continue;
    }
    console.log(`\n${testCase.id} — ${testCase.title}`);
    if (!(await alive())) {
      report.note(`${testCase.id}: the app was not reachable before this case; relaunched`);
      await relaunch();
    }
    const context = caseContext(testCase.id);
    const caseStartedAt = await page.evaluate('Date.now()');
    try {
      await testCase.run(context);
    } catch (error) {
      report.check({ id: `${testCase.id}/completed`, type: 'harness', title: 'The case ran to completion', pass: false, actual: String(error.message ?? error) });
      if (await alive()) {
        await harness.reset().catch(() => undefined);
        await harness.setBackdrop(null).catch(() => undefined);
        await harness.setChromeHidden(false).catch(() => undefined);
      }
    }
    report.snap(testCase.id, context.snap);
    // Coverage lives in the page, so it is collected after every case: a later crash cannot lose it.
    if (await alive()) {
      await collectCoverage();
      // Something outside the run that takes the foreground (a system dialog shortly after boot, for
      // example) pauses the app and can change what a call answers. Make that visible.
      if (!PAUSING_CASES.includes(testCase.id)) {
        const pauses = (await harness.log()).filter(
          (entry) => entry.kind === 'lifecycle' && entry.text === 'app: pause' && Date.parse(entry.time) >= caseStartedAt,
        );
        if (pauses.length > 0) {
          report.note(
            `${testCase.id}: the app was paused ${pauses.length} time(s) by something outside the run (first at ${pauses[0].time}); ` +
              'results of this case may reflect that interruption',
          );
        }
      }
    }
  }

  await collectCoverage();
  const environmentNow = (await alive()) ? await harness.environment() : environment;
  const allIds = (await alive()) ? [...(await harness.coverage()).exercised, ...(await harness.coverage()).notExercised] : [];
  const missing = allIds.filter((id) => !exercised.has(id));
  if (only.length === 0 && skip.length === 0) {
    report.check({
      id: 'coverage',
      type: 'harness',
      // "Sent" is all this says: it does not show that the effect of each option was verified.
      title: 'Every public method and every option was sent at least once during the run (sent, not verified for effect)',
      pass: allIds.length > 0 && missing.length === 0,
      actual: { items: allIds.length, notExercised: missing },
    });
  }

  writeFileSync(join(outDir, 'logcat.txt'), device.adbRaw(['logcat', '-d', '-v', 'time', '-s', 'CameraPreview:V', 'CameraActivity:V', 'Preview:V', 'AndroidRuntime:E', 'Capacitor:E']));
  if (await alive()) {
    writeFileSync(join(outDir, 'test-record.json'), `${JSON.stringify(await harness.exportRecord(), null, 1)}\n`);
  }

  const complete = only.length === 0 && skip.length === 0;
  const snapshotPath = join(here, 'baseline', `android-${deviceKey}.json`);
  const snapshotName = `e2e/baseline/android-${deviceKey}.json`;
  /** False when a complete run could not be compared with (or turned into) a snapshot. */
  let snapshotSettled = true;
  if (complete) {
    mkdirSync(dirname(snapshotPath), { recursive: true });
    const mode = flag('record') ? 'record' : extend.length > 0 ? 'extend' : 'compare';
    // A run with failed or blocked checks must not become the fixture later runs are judged by.
    const blockers = report
      .checks()
      .filter((check) => (check.status === 'failed' || check.status === 'blocked') && !accepted.includes(check.id))
      .map((check) => check.id);
    const comparison = compareSnapshot(snapshotPath, report.snapshot(), { mode, keys: extend, blockers });
    if (comparison.mode === 'recorded') {
      report.note(`snapshot recorded: ${snapshotName}`);
    } else if (comparison.mode === 'extended') {
      report.note(`snapshot extended with ${comparison.added.join(', ')}: ${snapshotName}; every case recorded before matches and was left as it was`);
    } else if (comparison.mode === 'missing') {
      snapshotSettled = false;
      report.skip({
        id: 'snapshot',
        title: `Every recorded outcome matches ${snapshotName}`,
        status: 'blocked',
        reason: 'there is no recorded snapshot for this device configuration, so nothing was compared and nothing was written; record one with --record on the backend that is to be the reference',
      });
    } else if (comparison.mode === 'refused') {
      snapshotSettled = false;
      report.check({
        id: 'snapshot',
        title: `The snapshot ${snapshotName} was ${mode === 'record' ? 'recorded' : 'extended'}`,
        pass: false,
        actual: { notWritten: comparison.reason, differences: comparison.differences.slice(0, 20) },
      });
    } else {
      report.check({
        id: 'snapshot',
        title: `Every recorded outcome matches ${snapshotName}`,
        pass: comparison.differences.length === 0,
        actual: comparison.differences.slice(0, 20),
      });
    }
  } else {
    report.note('partial run: the snapshot was neither compared nor recorded');
  }

  report.write(outDir, {
    device: `${info.model}, Android ${info.release} (API ${info.sdk}), ${info.abi}`,
    display: `${info.widthPx}x${info.heightPx} @ ${info.densityDpi} dpi, devicePixelRatio ${environmentNow.devicePixelRatio}`,
    pageSize: info.pageSize ?? 'unknown',
    webView: environmentNow.userAgent,
    appId,
    pluginPackageVersion: environmentNow.pluginPackageVersion,
    deviceKey,
    timingsMs: timings,
  });
  exitCode = report.failed().length === 0 && snapshotSettled ? 0 : 1;
} catch (error) {
  console.error(`android-baseline: ${error.stack ?? error}`);
  report.note(`run aborted: ${error.message ?? error}`);
  report.write(outDir, { deviceKey });
} finally {
  page?.close();
  device.removeForward(port);
}

process.exit(exitCode);
