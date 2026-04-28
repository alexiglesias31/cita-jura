import { createServer } from 'node:http';
import { runCheck } from './check.js';

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const CHECK_INTERVAL_MS = Number.parseInt(
  process.env.CHECK_INTERVAL_MS ?? String(7 * 60 * 1000),
  10,
);
const RUN_ON_START = process.env.RUN_ON_START !== 'false';
const TRIGGER_KEY = process.env.TRIGGER_KEY;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

let running = false;
let lastRun = null;
let lastError = null;
let consecutiveErrors = 0;

async function tick(reason = 'interval') {
  if (running) {
    log(`[${reason}] skipped: a check is already running`);
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
    tick('manual');
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ triggered: true, running }));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, HOST, () => {
  log(`HTTP listening on ${HOST}:${PORT}. Interval=${CHECK_INTERVAL_MS}ms`);
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
