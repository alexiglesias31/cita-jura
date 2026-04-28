import('./server.js').catch((err) => {
  console.error('Failed to start server.js:', err);
  process.exit(1);
});
