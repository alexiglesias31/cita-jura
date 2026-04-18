// Bootstrap entry point. Sets PLAYWRIGHT_BROWSERS_PATH before loading
// server.js, so Playwright's module-level browser-directory resolution
// sees the correct value. Kept free of top-level await for compatibility
// with hosts like Hostinger LSWS that may load modules via require().
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '0';

import('./server.js').catch((err) => {
  console.error('Failed to start server.js:', err);
  process.exit(1);
});
