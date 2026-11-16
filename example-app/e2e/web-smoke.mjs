// Web smoke test: serves the built example app, opens it in headless Chrome with a fake camera and
// drives the harness over the DevTools protocol.
//
//   npx ng build --configuration development
//   node e2e/web-smoke.mjs [--out <dir>] [--www <dir>] [--port 4310] [--debug-port 9333]
//
// It is evidence about the shared example app and the web implementation only. It says nothing
// about a native camera.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { connect } from './lib/cdp.mjs';
import { attachHarness } from './lib/harness-client.mjs';
import { extensionFor, inspectImage } from './lib/image-info.mjs';
import { createReport } from './lib/report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};

const wwwDir = resolve(option('www', join(here, '..', 'www', 'browser')));
const outDir = resolve(option('out', join(here, 'out', 'web-smoke')));
const port = Number(option('port', '4310'));
const debugPort = Number(option('debug-port', '9333'));
const chromeBin =
  process.env.CHROME_BIN ??
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(
    (candidate) => existsSync(candidate),
  );

if (!existsSync(join(wwwDir, 'index.html'))) {
  console.error(`web-smoke: ${wwwDir} has no index.html — build the app first (npx ng build --configuration development).`);
  process.exit(2);
}
if (!chromeBin) {
  console.error('web-smoke: no Chrome found; set CHROME_BIN.');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.map': 'application/json',
};

const server = createServer((request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
  let file = join(wwwDir, path);
  // Single-page app: unknown paths (the /home route) fall back to index.html.
  if (!file.startsWith(wwwDir) || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(wwwDir, 'index.html');
  }
  response.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  response.end(readFileSync(file));
});
await new Promise((done) => server.listen(port, '127.0.0.1', done));

const profile = mkdtempSync(join(tmpdir(), 'cph-web-smoke-'));
const chrome = spawn(
  chromeBin,
  [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=412,915',
    `http://localhost:${port}/`,
  ],
  { stdio: 'ignore' },
);

const report = createReport({ kind: 'web-smoke', title: 'Example app — web smoke test (headless Chrome, fake camera)' });
let exitCode = 1;

try {
  const page = await connect(debugPort, { urlPattern: new RegExp(`localhost:${port}`) });
  const harness = await attachHarness(page);
  const environment = await harness.environment();
  await harness.setPolling(false);

  const saveScreenshot = async (name) => {
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
  };
  const saveImage = async (name, record) => {
    const bytes = await harness.imageBytes(record.id);
    if (!bytes) {
      return null;
    }
    const info = inspectImage(bytes);
    writeFileSync(join(outDir, `${name}.${extensionFor(info.format)}`), bytes);
    return info;
  };
  const rejectedAsUnsupported = (record) => record.outcome === 'rejected' && record.expectedUnsupported === true;

  report.check({
    id: 'WEB-ENV',
    type: 'harness',
    title: 'The automation entry point is installed and reports the web platform',
    pass: environment.platform === 'web' && environment.native === false,
    actual: { platform: environment.platform, native: environment.native, plugin: environment.pluginPackageVersion },
  });

  // Every panel renders something.
  for (const panel of ['configure', 'live', 'results', 'log', 'lab', 'coverage']) {
    const length = await page.evaluate(`(async () => {
      document.querySelector('[data-testid="tab-${panel}"]').click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      return document.querySelector('[data-testid="panel"]').innerText.trim().length;
    })()`);
    await saveScreenshot(`panel-${panel}`);
    report.check({
      id: `WEB-PANEL-${panel}`,
      type: 'harness',
      title: `Panel "${panel}" renders`,
      pass: length > 20,
      actual: `${length} characters`,
    });
  }
  await page.evaluate(`document.querySelector('[data-testid="tab-configure"]').click()`);

  const startOptions = { position: 'rear', parent: 'cph-web-preview', disableAudio: true };

  // Methods the web implementation does not have.
  const probe = await harness.call('isCameraStarted');
  report.check({
    id: 'WEB-READY-UNSUPPORTED',
    title: 'isCameraStarted() rejects and is classified as unsupported on the web, not as a failure',
    pass: rejectedAsUnsupported(probe),
    actual: { outcome: probe.outcome, error: probe.error, expectedUnsupported: probe.expectedUnsupported },
  });

  const started = await harness.call('start', startOptions);
  const videoPresent = await page.evaluate(`!!document.querySelector('#cph-web-preview video')`);
  report.check({
    id: 'WEB-START',
    title: 'start() resolves and the <video> element is attached to the parent',
    pass: started.outcome === 'resolved' && videoPresent,
    actual: { outcome: started.outcome, error: started.error, videoPresent },
  });
  await page.evaluate('new Promise((resolve) => setTimeout(resolve, 800))');
  await saveScreenshot('running');

  const duplicate = await harness.call('start', startOptions);
  report.check({
    id: 'WEB-START-DUPLICATE',
    title: 'A second start() rejects with "camera already started"',
    pass: duplicate.outcome === 'rejected' && duplicate.error === 'camera already started',
    actual: { outcome: duplicate.outcome, error: duplicate.error },
  });

  // Output format follows `quality`: JPEG when sent, PNG when omitted. The diagnostics must report
  // the real format in both cases, and the in-app reader must agree with the host reader.
  const outputs = [
    ['capture', { quality: 85 }, 'jpeg'],
    ['capture', {}, 'png'],
    ['captureSample', { quality: 60 }, 'jpeg'],
    ['captureSample', {}, 'png'],
  ];
  for (const [method, callArgs, expectedFormat] of outputs) {
    const record = await harness.call(method, callArgs);
    const name = `${method}-${expectedFormat}`;
    const hostInfo = record.outcome === 'resolved' ? await saveImage(name, record) : null;
    const appInfo = record.image?.info ?? null;
    report.check({
      id: `WEB-${method.toUpperCase()}-${expectedFormat.toUpperCase()}`,
      title: `${method}(${JSON.stringify(callArgs)}) returns base64 ${expectedFormat.toUpperCase()} and is classified as such`,
      pass:
        record.outcome === 'resolved' &&
        hostInfo?.format === expectedFormat &&
        record.image?.classification.detected.kind === 'base64' &&
        record.image?.classification.detected.format === expectedFormat &&
        record.image?.classification.consistent === true,
      actual: {
        outcome: record.outcome,
        error: record.error,
        hostFormat: hostInfo?.format,
        classification: record.image?.classification,
      },
    });
    report.check({
      id: `WEB-${method.toUpperCase()}-${expectedFormat.toUpperCase()}-READERS`,
      type: 'harness',
      title: `In-app and host image readers agree for the ${expectedFormat.toUpperCase()} ${method} result`,
      pass:
        !!appInfo &&
        !!hostInfo &&
        appInfo.format === hostInfo.format &&
        appInfo.encodedWidth === hostInfo.encodedWidth &&
        appInfo.encodedHeight === hostInfo.encodedHeight &&
        appInfo.byteLength === hostInfo.byteLength &&
        (expectedFormat === 'png' ? appInfo.jpeg === null && appInfo.png !== null : appInfo.jpeg !== null),
      actual: {
        app: appInfo && { format: appInfo.format, size: [appInfo.encodedWidth, appInfo.encodedHeight], jpeg: appInfo.jpeg !== null, png: appInfo.png !== null },
        host: hostInfo && { format: hostInfo.format, size: [hostInfo.encodedWidth, hostInfo.encodedHeight] },
      },
    });
  }

  // The result panel must label JPEG-only metadata as not applicable for the PNG result just taken.
  const facts = await page.evaluate(`(async () => {
    document.querySelector('[data-testid="tab-results"]').click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return document.querySelector('[data-testid="result-facts"]').innerText;
  })()`);
  await saveScreenshot('result-png');
  report.check({
    id: 'WEB-RESULT-PNG-LABELS',
    type: 'harness',
    title: 'Result panel shows the PNG format and marks EXIF and JPEG metadata as not applicable',
    pass: /PNG/.test(facts) && /not applicable \(PNG\)/.test(facts) && !/no EXIF block/.test(facts),
    actual: facts.replace(/\s+/g, ' ').slice(0, 400),
  });

  const opacity = await harness.call('setOpacity', { opacity: 0.5 });
  const opacityApplied = await page.evaluate(`document.querySelector('#cph-web-preview video').style.opacity`);
  report.check({
    id: 'WEB-OPACITY',
    title: 'setOpacity({ opacity: 0.5 }) resolves and is applied to the video element',
    pass: opacity.outcome === 'resolved' && opacityApplied === '0.5',
    actual: { outcome: opacity.outcome, style: opacityApplied },
  });
  const opacityZero = await harness.call('setOpacity', { opacity: 0 });
  const opacityAfterZero = await page.evaluate(`document.querySelector('#cph-web-preview video').style.opacity`);
  report.check({
    id: 'WEB-OPACITY-ZERO',
    type: 'known-defect',
    title: 'setOpacity({ opacity: 0 }) resolves but is ignored (the previous opacity stays)',
    pass: opacityZero.outcome === 'resolved' && opacityAfterZero === '0.5',
    actual: { outcome: opacityZero.outcome, style: opacityAfterZero },
    ref: 'src/web.ts setOpacity: `!!_options["opacity"]` is false for 0',
  });

  for (const [method, callArgs] of [
    ['flip', undefined],
    ['getSupportedFlashModes', undefined],
    ['setFlashMode', { flashMode: 'off' }],
    ['startRecordVideo', {}],
    ['stopRecordVideo', undefined],
  ]) {
    const record = await harness.call(method, callArgs);
    report.check({
      id: `WEB-UNSUPPORTED-${method}`,
      title: `${method}() rejects and is classified as unsupported on the web`,
      pass: rejectedAsUnsupported(record),
      actual: { outcome: record.outcome, error: record.error, expectedUnsupported: record.expectedUnsupported },
    });
  }

  const stopped = await harness.call('stop');
  const videoGone = await page.evaluate(`!document.querySelector('#cph-web-preview video')`);
  report.check({
    id: 'WEB-STOP',
    title: 'stop() resolves and removes the <video> element',
    pass: stopped.outcome === 'resolved' && videoGone,
    actual: { outcome: stopped.outcome, videoGone },
  });
  const stoppedAgain = await harness.call('stop');
  report.check({
    id: 'WEB-STOP-AGAIN',
    title: 'stop() with nothing running resolves on the web (native platforms reject)',
    pass: stoppedAgain.outcome === 'resolved',
    actual: { outcome: stoppedAgain.outcome, error: stoppedAgain.error },
  });

  const lab = await harness.runScenario('no-session');
  report.check({
    id: 'WEB-LAB-NO-SESSION',
    type: 'harness',
    title: 'Lab scenario "no-session" runs and reports an outcome for every call',
    pass: lab.groups.length === 1 && lab.groups[0].calls.length === 10,
    actual: lab.groups[0]?.calls.map((call) => `${call.label}:${call.outcome}`),
  });
  report.snap('lab:no-session', lab.groups[0]?.calls.map((call) => ({ label: call.label, outcome: call.outcome, error: call.error ?? null })));

  // Last, because it leaves a promise pending for the whole 20 s deadline.
  const noParent = await harness.call('start', { position: 'rear', disableAudio: true });
  report.check({
    id: 'WEB-START-NO-PARENT',
    type: 'known-defect',
    title: 'start() without `parent` never settles; the harness reports it as unsettled',
    pass: noParent.outcome === 'unsettled',
    actual: { outcome: noParent.outcome, error: noParent.error, durationMs: noParent.durationMs },
    ref: 'src/web.ts start: parent.appendChild on a null parent throws inside the promise executor',
  });
  await harness.reset();

  const coverage = await harness.coverage();
  report.check({
    id: 'WEB-COVERAGE',
    type: 'harness',
    title: 'Every public method was issued at least once during this run',
    pass: !coverage.notExercised.some((id) => !id.includes('.')),
    actual: { methodsNotExercised: coverage.notExercised.filter((id) => !id.includes('.')) },
  });

  writeFileSync(join(outDir, 'test-record.json'), `${JSON.stringify(await harness.exportRecord(), null, 1)}\n`);
  writeFileSync(join(outDir, 'console.log'), `${page.consoleLines().join('\n')}\n`);
  page.close();

  report.write(outDir, { chrome: environment.userAgent, viewport: `${environment.viewport.width}x${environment.viewport.height}` });
  exitCode = report.failed().length === 0 ? 0 : 1;
} catch (error) {
  console.error(`web-smoke: ${error.stack ?? error}`);
  report.note(`run aborted: ${error.message ?? error}`);
  report.write(outDir);
} finally {
  chrome.kill();
  server.close();
  await new Promise((done) => setTimeout(done, 300));
  rmSync(profile, { recursive: true, force: true });
}

process.exit(exitCode);
