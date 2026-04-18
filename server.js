import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readdirSync, chmodSync, statSync } from 'node:fs';
import path from 'node:path';
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

function getPlaywrightCli() {
  for (const name of ['playwright', 'playwright-core']) {
    try {
      const pkgPath = require.resolve(`${name}/package.json`);
      return path.join(path.dirname(pkgPath), 'cli.js');
    } catch {
      // try next
    }
  }
  return null;
}

function getLocalBrowsersDir() {
  try {
    const pkgPath = require.resolve('playwright-core/package.json');
    return path.join(path.dirname(pkgPath), '.local-browsers');
  } catch {
    return null;
  }
}

// Hostinger's deploy copies files from the build dir to the runtime dir and
// drops the +x bit in the process, so Chromium fails with EACCES even though
// the binary exists. chmod 755 everything under .local-browsers recursively.
function chmodBrowsers() {
  const dir = getLocalBrowsersDir();
  if (!dir) return;
  let fileCount = 0;
  let errorCount = 0;
  const walk = (p) => {
    let entries;
    try {
      entries = readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) {
        try {
          chmodSync(full, 0o755);
        } catch {
          errorCount += 1;
        }
        walk(full);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        try {
          chmodSync(full, 0o755);
          fileCount += 1;
        } catch {
          errorCount += 1;
        }
      }
    }
  };
  try {
    statSync(dir);
  } catch {
    log(`No .local-browsers dir at ${dir}, skipping chmod`);
    return;
  }
  walk(dir);
  log(`chmod 755 applied to ${fileCount} files under ${dir} (errors=${errorCount})`);
}

function ensureChromium() {
  return new Promise((resolve) => {
    if (SKIP_BROWSER_INSTALL) {
      log('Skipping playwright install (SKIP_BROWSER_INSTALL=true)');
      chmodBrowsers();
      resolve();
      return;
    }
    const cliPath = getPlaywrightCli();
    if (!cliPath) {
      log('Could not locate playwright CLI — will try to launch anyway.');
      chmodBrowsers();
      resolve();
      return;
    }
    log(
      `Ensuring Chromium: ${process.execPath} ${cliPath} install chromium ` +
        `(PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH})`,
    );
    const child = spawn(process.execPath, [cliPath, 'install', 'chromium'], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => {
      log(`playwright install exited with code ${code}`);
      chmodBrowsers();
      resolve();
    });
    child.on('error', (err) => {
      log('playwright install spawn error:', err.message);
      chmodBrowsers();
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
        browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH,
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
  log(`HTTP listening on ${HOST}:${PORT}. Interval=${CHECK_INTERVAL_MS}ms browsersPath=${process.env.PLAYWRIGHT_BROWSERS_PATH}`);
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
