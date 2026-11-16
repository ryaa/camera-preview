// iOS simulator smoke test for the example app.
//
//   node e2e/ios-smoke.mjs --app <path to the built App.app> [--runtime 26.5] [--device <udid>] [--out <dir>]
//
// The simulator has no camera and no debugger this script could attach to, so the run works
// differently from the Android and web ones: a copy of the built app gets an autorun plan
// (assets/harness-autorun.json), the app executes it on launch, and the results are read back from
// the app's console. The build product itself is never modified, and unless --device names an
// existing simulator the script creates a temporary one and deletes it afterwards.
//
// What this proves: the shared example app builds, launches and renders on iOS, the automation
// entry point works there, and every call settles or is reported as unsettled without a camera.
// It proves nothing about camera behaviour on iOS, and nothing at all about Android.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createReport } from './lib/report.mjs';
import { createScreenshotTracker } from './lib/screenshots.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};

const builtApp = option('app') ? resolve(option('app')) : null;
const outDir = resolve(option('out', join(here, 'out', 'ios-smoke')));
const requestedDevice = option('device', null);
const requestedRuntime = option('runtime', null);
const LINE = '[cph-autorun]';
const DONE = '[cph-autorun-done]';
const PART = '[cph-autorun-part]';

if (!builtApp || !existsSync(join(builtApp, 'Info.plist'))) {
  console.error(
    'ios-smoke: pass --app <App.app>. Build it for the simulator first, for example:\n' +
      '  npx cap sync --inline ios\n' +
      '  xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug -sdk iphonesimulator \\\n' +
      "    -destination 'generic/platform=iOS Simulator' -derivedDataPath <dir> CODE_SIGNING_ALLOWED=NO build",
  );
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const simctl = (args, options = {}) =>
  execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });

/** Panels are shown one after another so a host screenshot of each can be taken. */
const PANELS = ['configure', 'live', 'results', 'log', 'lab', 'coverage'];
const plan = {
  enabled: true,
  steps: [
    ...PANELS.flatMap((panel) => [{ panel }, { wait: 2500 }]),
    { panel: 'log' },
    { call: 'isCameraStarted' },
    { call: 'start', args: { position: 'rear', toBack: true, disableAudio: true } },
    { call: 'isCameraStarted' },
    { call: 'setOpacity', args: { opacity: 0.5 } },
    { scenario: 'no-session' },
    { call: 'stop' },
    { wait: 2500 },
  ],
};

const report = createReport({ kind: 'ios-smoke', title: 'Example app — iOS simulator smoke test (no camera)' });
const workDir = mkdtempSync(join(tmpdir(), 'cph-ios-smoke-'));
let device = requestedDevice;
let createdDevice = false;
let bootedHere = false;
let exitCode = 1;

try {
  // A private copy of the app carries the autorun plan; the build product stays as built.
  const app = join(workDir, 'App.app');
  cpSync(builtApp, app, { recursive: true });
  const assets = join(app, 'public', 'assets');
  if (!existsSync(assets)) {
    throw new Error(`${builtApp} has no public/assets — was "cap sync ios" run before the build?`);
  }
  writeFileSync(join(assets, 'harness-autorun.json'), JSON.stringify(plan));
  const bundleId = execFileSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', join(app, 'Info.plist')], {
    encoding: 'utf8',
  }).trim();

  const listing = JSON.parse(simctl(['list', '-j', 'devices', 'available']));
  if (!device) {
    const runtimes = JSON.parse(simctl(['list', '-j', 'runtimes'])).runtimes.filter(
      (runtime) =>
        runtime.isAvailable &&
        runtime.platform === 'iOS' &&
        (requestedRuntime === null || runtime.version.startsWith(requestedRuntime)),
    );
    const runtime = runtimes.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true })).at(-1);
    const deviceType =
      runtime?.supportedDeviceTypes?.find((type) => /^iPhone \d+$/.test(type.name)) ??
      runtime?.supportedDeviceTypes?.find((type) => type.productFamily === 'iPhone');
    if (!runtime || !deviceType) {
      throw new Error(`no available iOS simulator runtime${requestedRuntime ? ` ${requestedRuntime}` : ''} with an iPhone device type`);
    }
    device = simctl(['create', 'cph-ios-smoke', deviceType.identifier, runtime.identifier]).trim();
    createdDevice = true;
    report.note(`temporary simulator: ${deviceType.name}, iOS ${runtime.version}`);
  }
  const state = Object.values(listing.devices)
    .flat()
    .find((candidate) => candidate.udid === device)?.state;
  if (state !== 'Booted') {
    simctl(['boot', device]);
    bootedHere = true;
  }
  simctl(['bootstatus', device, '-b'], { timeout: 300_000 });

  simctl(['install', device, app]);
  // Granting up front keeps the permission dialogs from blocking an unattended run.
  for (const service of ['camera', 'microphone']) {
    try {
      simctl(['privacy', device, 'grant', service, bundleId]);
    } catch {
      report.note(`could not pre-grant ${service}`);
    }
  }

  // Launch with the console attached and read the autorun lines as the app prints them.
  const records = [];
  let done = null;
  let consoleText = '';
  // Only screenshots taken by this run count; a file left in a reused output folder never does.
  const shots = createScreenshotTracker({
    outDir,
    capture: (file) => simctl(['io', device, 'screenshot', file], { stdio: 'ignore' }),
  });
  const panelsShown = [];
  await new Promise((finish) => {
    const child = spawn('xcrun', ['simctl', 'launch', '--console-pty', '--terminate-running-process', device, bundleId]);
    const timer = setTimeout(() => child.kill(), 180_000);
    let buffer = '';
    const parts = new Map();
    const handle = (marker, json) => {
      if (marker === DONE) {
        done = JSON.parse(json);
        // Capture the final state (the log panel with every outcome) before the app goes away.
        setTimeout(() => {
          shots.take('final');
          child.kill();
        }, 600);
        return;
      }
      const record = JSON.parse(json);
      records.push(record);
      if (record.step === 'panel' && record.panel && !panelsShown.includes(record.panel)) {
        // The plan waits after each panel switch; the screenshot is taken inside that wait.
        panelsShown.push(record.panel);
        shots.schedule(`panel-${record.panel}`, 900);
      }
    };
    const onData = (chunk) => {
      consoleText += chunk;
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        try {
          const partAt = line.indexOf(PART);
          if (partAt >= 0) {
            // "[cph-autorun-part] <id> <index>/<count> <marker> <piece>": a message too long for one console line.
            const [, id, position, marker, piece] = line.slice(partAt).match(/^\S+ (\d+) (\d+\/\d+) (\S+) (.*)$/) ?? [];
            const [index, count] = (position ?? '0/0').split('/').map(Number);
            const pieces = parts.get(id) ?? [];
            pieces[index - 1] = piece;
            parts.set(id, pieces);
            if (count > 0 && pieces.filter((value) => value !== undefined).length === count) {
              parts.delete(id);
              handle(marker, pieces.join(''));
            }
          } else if (line.includes(DONE)) {
            handle(DONE, line.slice(line.indexOf(DONE) + DONE.length));
          } else if (line.includes(LINE)) {
            handle(LINE, line.slice(line.indexOf(LINE) + LINE.length));
          }
        } catch {
          report.note(`unparseable autorun line: ${line.slice(0, 160)}`);
        }
      }
    };
    child.stdout.setEncoding('utf8').on('data', onData);
    child.stderr.setEncoding('utf8').on('data', onData);
    child.on('close', () => {
      clearTimeout(timer);
      finish();
    });
  });
  // A capture scheduled just before the app went away may not have been attempted yet.
  await shots.settled();
  for (const [name, error] of Object.entries(shots.failures())) {
    report.note(`screenshot ${name} failed: ${error}`);
  }
  writeFileSync(join(outDir, 'app-console.log'), consoleText);
  writeFileSync(join(outDir, 'autorun-records.json'), `${JSON.stringify({ plan, records, done }, null, 1)}\n`);

  // ---------------------------------------------------------------- checks
  const environment = records.find((record) => record.environment)?.environment;
  const calls = records.filter((record) => record.step === 'call').map((record) => record.record);
  const callOf = (method, nth = 0) => calls.filter((record) => record.method === method)[nth];
  const lab = records.find((record) => record.step === 'scenario')?.result;
  const brief = (record) => record && { outcome: record.outcome, error: record.error, expectedUnsupported: record.expectedUnsupported };

  if (!environment) {
    report.note(
      'The app printed nothing. If it exited at launch, look for a crash report: an app without the UIScene ' +
        'life cycle built with the iOS 27 SDK is terminated at launch on iOS 27 — use --runtime with an older one.',
    );
  }
  report.check({
    id: 'IOS-LAUNCH',
    type: 'harness',
    title: 'The app launches on the simulator and the automation entry point reports the iOS platform',
    pass: environment?.platform === 'ios' && environment?.native === true,
    actual: environment && { platform: environment.platform, native: environment.native, plugin: environment.pluginPackageVersion, viewport: environment.viewport },
  });
  report.check({
    id: 'IOS-COMPLETED',
    type: 'harness',
    title: 'The autorun plan ran to its end (the app did not terminate part-way)',
    pass: done !== null && done.steps === plan.steps.length,
    actual: done ? { steps: done.steps } : `stopped after ${records.length} of ${plan.steps.length + 1} lines`,
  });
  report.check({
    id: 'IOS-PANELS',
    type: 'harness',
    title: 'Every panel was shown and captured in a screenshot during this run',
    pass: PANELS.every((panel) => panelsShown.includes(panel) && shots.succeeded(`panel-${panel}`)),
    actual: {
      shown: panelsShown,
      captured: PANELS.filter((panel) => shots.succeeded(`panel-${panel}`)),
      failed: shots.failures(),
    },
  });

  const firstProbe = callOf('isCameraStarted', 0);
  report.check({
    id: 'IOS-NOT-STARTED',
    title: 'isCameraStarted() resolves false before any start()',
    pass: firstProbe?.outcome === 'resolved' && firstProbe.result?.value === false,
    actual: brief(firstProbe) ?? 'no record',
  });

  const start = callOf('start');
  if (start?.outcome === 'resolved') {
    report.note('start() resolved: this simulator provides a camera, so the no-camera expectations below do not apply');
  }
  report.check({
    id: 'IOS-START-SETTLES',
    title: 'start() settles on a simulator without a camera (a rejection is the expected outcome) and the app stays usable',
    pass: start !== undefined && start.outcome !== 'unsettled' && done !== null,
    actual: brief(start) ?? 'no record',
  });

  const opacity = callOf('setOpacity');
  report.check({
    id: 'IOS-OPACITY-UNSUPPORTED',
    title: 'setOpacity() rejects (the method is not registered on iOS) and is classified as unsupported, not as a failure',
    pass: opacity?.outcome === 'rejected' && opacity.expectedUnsupported === true,
    actual: brief(opacity) ?? 'no record',
  });

  const labCalls = lab?.groups?.[0]?.calls ?? [];
  const stopRecord = labCalls.find((call) => call.label === 'stopRecordVideo');
  report.check({
    id: 'IOS-NO-SESSION',
    type: 'harness',
    title: 'With nothing running, every method is issued and reported as resolved, rejected or unsettled',
    pass: labCalls.length === 10,
    actual: labCalls.map((call) => `${call.label}: ${call.outcome}${call.error ? ` (${call.error})` : ''}`),
  });
  report.check({
    id: 'IOS-STOP-RECORD-UNSETTLED',
    type: 'known-defect',
    title: 'stopRecordVideo() never settles on iOS; the harness reports it as unsettled instead of waiting for ever',
    pass: stopRecord?.outcome === 'unsettled',
    actual: stopRecord ?? 'no record',
    ref: 'ios CameraPreviewPlugin.stopRecordVideo never resolves or rejects its call; recording itself is not implemented there (the recorder start, stop and completion handler in CameraController.swift are commented out)',
  });
  report.snap(
    'no-session',
    labCalls.map((call) => ({ label: call.label, outcome: call.outcome, error: call.error ?? null })),
  );
  report.snap('start', brief(start) ?? null);

  report.write(outDir, {
    simulator: device,
    bundleId,
    userAgent: environment?.userAgent ?? 'unknown',
    viewport: environment ? `${environment.viewport.width}x${environment.viewport.height} @ ${environment.devicePixelRatio}x` : 'unknown',
  });
  exitCode = report.failed().length === 0 ? 0 : 1;

  try {
    simctl(['terminate', device, bundleId], { stdio: 'ignore' });
  } catch {
    // Already terminated.
  }
  simctl(['uninstall', device, bundleId]);
} catch (error) {
  console.error(`ios-smoke: ${error.stack ?? error}`);
  report.note(`run aborted: ${error.message ?? error}`);
  report.write(outDir);
} finally {
  if (device && createdDevice) {
    try {
      simctl(['shutdown', device], { stdio: 'ignore' });
    } catch {
      // Not booted.
    }
    simctl(['delete', device]);
  } else if (device && bootedHere) {
    simctl(['shutdown', device]);
  }
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(exitCode);
