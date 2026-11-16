// Host-side handle on `window.__cameraPreviewHarness`, the example app's automation entry point.
// Every plugin call made through it runs the same service wrapper a manual tap does.

const literal = (value) => (value === undefined ? 'undefined' : JSON.stringify(value));

export async function attachHarness(page, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const version = await page.evaluate('window.__cameraPreviewHarness ? window.__cameraPreviewHarness.version : null');
    if (version === 1) {
      break;
    }
    if (Date.now() > deadline) {
      throw new Error('harness: window.__cameraPreviewHarness did not appear — is this the Stage 1 example app?');
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const invoke = (member, args = [], options) =>
    page.evaluate(`window.__cameraPreviewHarness.${member}(${args.map(literal).join(', ')})`, options);

  return {
    environment: () => invoke('environment'),
    /** @returns {{ rect: object|null, source: string, controlBand: object|null, autoStopIn: number|null }} */
    preview: () => invoke('preview'),
    /** @returns the call record: { id, method, args, outcome, durationMs, result?, error?, image?, video? } */
    call: (method, args) => invoke('call', [method, args]),
    runScenario: (id, args) => invoke('runScenario', [id, args], { timeoutMs: 300_000 }),
    scenarios: () => invoke('scenarios'),
    /** Untouched bytes of a capture/sample result, or null when the app no longer holds them. */
    imageBytes: async (callId) => {
      const base64 = await invoke('imageBase64', [callId]);
      return base64 === null ? null : Buffer.from(base64, 'base64');
    },
    log: () => invoke('log'),
    clearLog: () => invoke('clearLog'),
    setChromeHidden: (hidden) => invoke('setChromeHidden', [hidden]),
    setBackdrop: (color) => invoke('setBackdrop', [color]),
    setPolling: (enabled) => invoke('setPolling', [enabled]),
    setAutoStop: (enabled) => invoke('setAutoStop', [enabled]),
    coverage: () => invoke('coverage'),
    exportRecord: () => invoke('exportRecord'),
    reset: () => invoke('reset'),

    /**
     * Issues start() and, while it is pending, samples isCameraStarted() every 50 ms.
     * @returns {{ start: object, pendingSamples: Array<boolean|string> }}
     */
    startWithReadinessProbe: (args) =>
      page.evaluate(`(async () => {
        const harness = window.__cameraPreviewHarness;
        const pendingSamples = [];
        let settled = false;
        const start = harness.call('start', ${literal(args)}).then((record) => { settled = true; return record; });
        while (!settled) {
          const probe = await harness.call('isCameraStarted');
          if (!settled) {
            pendingSamples.push(probe.outcome === 'resolved' ? probe.result.value : probe.outcome);
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return { start: await start, pendingSamples };
      })()`),

    /** Samples isCameraStarted() `count` times, `intervalMs` apart; used around host-driven lifecycle changes. */
    sampleReadiness: (count, intervalMs) =>
      page.evaluate(`(async () => {
        const harness = window.__cameraPreviewHarness;
        const samples = [];
        const t0 = performance.now();
        for (let index = 0; index < ${Number(count)}; index++) {
          const probe = await harness.call('isCameraStarted');
          samples.push({
            atMs: Math.round(performance.now() - t0),
            value: probe.outcome === 'resolved' ? probe.result.value : probe.outcome,
            visibility: document.visibilityState,
          });
          await new Promise((resolve) => setTimeout(resolve, ${Number(intervalMs)}));
        }
        return samples;
      })()`),
  };
}
