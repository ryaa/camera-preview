// Thin wrappers over the `adb` command line. The device is selected with ANDROID_SERIAL (or the
// only connected device), exactly as plain adb does.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function adbPath() {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), 'Library/Android/sdk');
  const candidate = join(sdk, 'platform-tools', 'adb');
  return existsSync(candidate) ? candidate : 'adb';
}

const ADB = adbPath();

/** Runs adb and returns stdout as a Buffer. Throws with stderr when adb exits non-zero. */
export function adbRaw(args, { timeoutMs = 60_000 } = {}) {
  return execFileSync(ADB, args, { maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function adb(args, options) {
  return adbRaw(args, options).toString('utf8').trim();
}

export function shell(command, options) {
  return adb(['shell', command], options);
}

export function tryShell(command) {
  try {
    return shell(command);
  } catch {
    return '';
  }
}

export function deviceInfo() {
  const size = shell('wm size').match(/(\d+)x(\d+)/);
  const density = shell('wm density').match(/(\d+)/);
  return {
    serial: adb(['get-serialno']),
    sdk: Number(shell('getprop ro.build.version.sdk')),
    release: shell('getprop ro.build.version.release'),
    model: shell('getprop ro.product.model'),
    abi: shell('getprop ro.product.cpu.abi'),
    pageSize: Number(tryShell('getconf PAGE_SIZE')) || null,
    widthPx: size ? Number(size[1]) : null,
    heightPx: size ? Number(size[2]) : null,
    densityDpi: density ? Number(density[1]) : null,
    webView: tryShell('dumpsys webviewupdate | grep -m1 "Current WebView package"').replace(/^\s+/, ''),
  };
}

export function screenshot() {
  return adbRaw(['exec-out', 'screencap', '-p']);
}

/** Reads a file from the app's private storage; works because the example app is debuggable. */
export function readAppFile(appId, path) {
  return adbRaw(['exec-out', 'run-as', appId, 'cat', path]);
}

export function isAppRunning(appId) {
  return tryShell(`pidof ${appId}`) !== '';
}

export function launch(appId, activity = '.MainActivity') {
  shell(`am start -n ${appId}/${activity}`);
}

/**
 * Forwards a local TCP port to the debuggable WebView of `appId` and returns the socket name.
 * The socket appears a moment after the WebView is created, so this polls for it.
 */
export async function forwardWebView(appId, port, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = tryShell(`pidof ${appId}`).split(/\s+/)[0];
    if (pid) {
      const sockets = tryShell('cat /proc/net/unix');
      const name = `webview_devtools_remote_${pid}`;
      if (sockets.includes(name)) {
        adb(['forward', `tcp:${port}`, `localabstract:${name}`]);
        return name;
      }
    }
    await sleep(300);
  }
  throw new Error(`adb: no debuggable WebView found for ${appId} — is the app a debug build and running?`);
}

export function removeForward(port) {
  try {
    adb(['forward', '--remove', `tcp:${port}`]);
  } catch {
    // Nothing was forwarded.
  }
}

/** Finds a button in the current window by its visible text and taps its centre. */
export function tapByText(pattern) {
  shell('uiautomator dump /sdcard/cph-window.xml');
  const xml = shell('cat /sdcard/cph-window.xml');
  for (const node of xml.split('<node ').slice(1)) {
    const text = node.match(/text="([^"]*)"/)?.[1] ?? '';
    const bounds = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (bounds && pattern.test(text)) {
      const x = Math.round((Number(bounds[1]) + Number(bounds[3])) / 2);
      const y = Math.round((Number(bounds[2]) + Number(bounds[4])) / 2);
      shell(`input tap ${x} ${y}`);
      return text;
    }
  }
  return null;
}

export { sleep };
