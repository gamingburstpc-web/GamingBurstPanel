'use strict';

require('dotenv').config();
const http       = require('http');
const express    = require('express');
const path       = require('path');
const { initDb } = require('./src/db');
const { setupWs } = require('./ws/wsHandler');

// ── Routes ──────────────────────────────────────────────────────────────────
const authRoutes      = require('./src/routes/authRoutes');
const dashboardRoutes = require('./src/routes/dashboardRoutes');
const serverRoutes    = require('./src/routes/serverRoutes');
const apiRoutes       = require('./src/routes/apiRoutes');

// ── Bootstrap ────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PANEL_PORT || '7676', 10);

async function main() {
  // 1. Initialise database (creates file + schema if missing, seeds admin)
  initDb();

  // 2. Express app
  const app = express();

  // Parse JSON + URL-encoded bodies (built-in, no body-parser needed in Express 4.16+)
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // Static assets
  app.use('/public', express.static(path.join(__dirname, 'public')));

  // ── Mount Routes ────────────────────────────────────────────────────────
  app.use('/',        authRoutes);
  app.use('/',        dashboardRoutes);
  app.use('/servers', serverRoutes);
  app.use('/api',     apiRoutes);

  // 404 catch-all
  app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'views', '404.html'));
  });

  // 3. Wrap in raw HTTP server (needed to share port with WebSocket)
  const server = http.createServer(app);

  // 4. Attach WebSocket handler (upgrades on same port as HTTP)
  setupWs(server);

  // 5. Listen
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  ╔════════════════════════════════════════╗`);
    console.log(`  ║   GamingBurst Panel  🎮                ║`);
    console.log(`  ║   http://0.0.0.0:${PORT}                  ║`);
    console.log(`  ╚════════════════════════════════════════╝\n`);
  });

  // 6. Graceful shutdown — kill all child Java processes before exit
  const pm = require('./src/processManager');
  const shutdown = (signal) => {
    console.log(`\n[Panel] Received ${signal}. Stopping all servers...`);
    pm.killAll();
    server.close(() => {
      console.log('[Panel] HTTP server closed. Goodbye.');
      process.exit(0);
    });
    // Force exit after 8 seconds if servers don't stop
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

main().catch(err => {
  console.error('[Panel] Fatal startup error:', err);
  process.exit(1);
});
