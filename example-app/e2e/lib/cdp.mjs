// Minimal Chrome DevTools Protocol client built on Node 22's fetch and WebSocket (no dependencies).
// It attaches to the page of an Android WebView (through `adb forward`) or of a desktop Chrome and
// evaluates expressions in it, so plugin calls travel through the real Capacitor bridge.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until the debugger endpoint lists a page whose URL matches `urlPattern`. */
export async function findPage(port, { urlPattern = /./, timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no page listed';
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find((target) => target.type === 'page' && urlPattern.test(target.url));
      if (page) {
        return page;
      }
      lastError = `no page matching ${urlPattern} among ${targets.map((target) => target.url).join(', ')}`;
    } catch (error) {
      lastError = String(error?.message ?? error);
    }
    await sleep(250);
  }
  throw new Error(`CDP: ${lastError} (port ${port})`);
}

export async function connect(port, options = {}) {
  const page = await findPage(port, options);
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error(`CDP: cannot open ${page.webSocketDebuggerUrl}`)), {
      once: true,
    });
  });

  let nextId = 0;
  let closed = false;
  const pending = new Map();
  const consoleLines = [];
  // When the app dies the socket closes; fail whatever is waiting instead of leaving it to time out.
  socket.addEventListener('close', () => {
    closed = true;
    for (const settle of pending.values()) {
      settle({ error: { message: 'the page closed the connection' } });
    }
    pending.clear();
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method === 'Runtime.consoleAPICalled') {
      consoleLines.push(
        `[${message.params.type}] ${message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ')}`,
      );
    } else if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      consoleLines.push(`[exception] ${details.exception?.description ?? details.text}`);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (closed || socket.readyState !== WebSocket.OPEN) {
        reject(new Error(`CDP ${method}: the connection to the page is closed`));
        return;
      }
      const id = ++nextId;
      pending.set(id, (message) =>
        message.error ? reject(new Error(`CDP ${method}: ${message.error.message}`)) : resolve(message.result),
      );
      socket.send(JSON.stringify({ id, method, params }));
    });

  await send('Runtime.enable');

  /**
   * Evaluates an expression in the page and returns its JSON value. A promise is awaited. A thrown
   * error or a rejected promise becomes a rejected promise here, with the page's message.
   */
  const evaluate = async (expression, { timeoutMs = 120_000 } = {}) => {
    const evaluation = send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    const timer = sleep(timeoutMs).then(() => {
      throw new Error(`CDP: evaluation did not finish within ${timeoutMs} ms: ${expression.slice(0, 120)}`);
    });
    const result = await Promise.race([evaluation, timer]);
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(`page threw: ${details.exception?.description ?? details.text}`);
    }
    return result.result.value;
  };

  return {
    page,
    send,
    evaluate,
    /** Console output and uncaught exceptions seen since the connection opened. */
    consoleLines: () => consoleLines.slice(),
    isOpen: () => !closed && socket.readyState === WebSocket.OPEN,
    close: () => socket.close(),
  };
}
