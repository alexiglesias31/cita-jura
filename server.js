import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { runCheck } from './check.js';

const require = createRequire(import.meta.url);

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const CHECK_INTERVAL_MS = Number.parseInt(
  process.env.CHECK_INTERVAL_MS ?? String(15 * 60 * 1000),
  10,
);
const RUN_ON_START = process.env.RUN_ON_START !== 'false';
const TRIGGER_KEY = process.env.TRIGGER_KEY;
const SKIP_BROWSER_INSTALL = process.env.SKIP_BROWSER_INSTALL === 'true';

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

let running = false;
let browserReady = false;
let lastRun = null;
let lastError = null;
let consecutiveErrors = 0;

function ensureChromium() {
  return new Promise((resolve) => {
    if (SKIP_BROWSER_INSTALL) {
      log('Skipping playwright install (SKIP_BROWSER_INSTALL=true)');
      resolve();
      return;
    }
    let cliPath;
    try {
      cliPath = require.resolve('playwright/cli.js');
    } catch (err) {
      log('Could not resolve playwright/cli.js:', err.message);
      resolve();
      return;
    }
    log(`Ensuring Playwright Chromium via ${process.execPath} ${cliPath} install chromium`);
    const child = spawn(process.execPath, [cliPath, 'install', 'chromium'], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => {
      log(`playwright install exited with code ${code}`);
      resolve();
    });
    child.on('error', (err) => {
      log('playwright install spawn error:', err.message);
      resolve();
    });
  });
}

async function tick(reason = 'interval') {
  if (running) {
    log(`[${reason}] skipped: a check is already running`);
    return { skipped: true };
  }
  if (!browserReady) {
    log(`[${reason}] skipped: browser not ready yet`);
    return { skipped: true };
  }
  running = true;
  const startedAt = new Date().toISOString();
  log(`[${reason}] check starting`);
  try {
    const result = await runCheck();
    lastRun = { reason, startedAt, finishedAt: new Date().toISOString(), result };
    lastError = null;
    consecutiveErrors = 0;
    log(`[${reason}] check done. found=${result.found.length} months=${result.monthsScanned.length}`);
    return lastRun;
  } catch (err) {
    consecutiveErrors += 1;
    lastError = {
      reason,
      startedAt,
      finishedAt: new Date().toISOString(),
      message: err.message,
      stack: err.stack,
    };
    console.error(`[${reason}] check failed:`, err);
    return { error: lastError };
  } finally {
    running = false;
  }
}

const server = createServer(async (req, res) => {
  const url = new globalThis.URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/' || url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        running,
        browserReady,
        consecutiveErrors,
        lastRun,
        lastError,
        intervalMs: CHECK_INTERVAL_MS,
      }),
    );
    return;
  }

  if (url.pathname === '/check') {
    if (TRIGGER_KEY && url.searchParams.get('key') !== TRIGGER_KEY) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid or missing key' }));
      return;
    }
    tick('manual'); // fire and forget; checks take ~30s+
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ triggered: true, running, browserReady }));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, HOST, async () => {
  log(`HTTP listening on ${HOST}:${PORT}. Interval=${CHECK_INTERVAL_MS}ms`);
  await ensureChromium();
  browserReady = true;
  if (RUN_ON_START) tick('startup');
  setInterval(() => tick('interval'), CHECK_INTERVAL_MS);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`Received ${sig}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
