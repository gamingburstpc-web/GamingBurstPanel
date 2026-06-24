'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const https    = require('https');
const { requireAuth, requireAdmin, cookieMiddleware } = require('../auth');
const { getDb } = require('../db');
const pm = require('../processManager');

const router = express.Router();
router.use(cookieMiddleware);
router.use(requireAuth);

const SERVERS_DIR = path.resolve(process.env.SERVERS_DIR || './servers');

// ── GET /api/me — returns current user info (role etc.) ──────────────────────
router.get('/me', (req, res) => {
  res.json({
    id:       req.session.userId,
    username: req.session.username,
    isAdmin:  req.session.isAdmin,
  });
});

// ── PaperMC helpers ───────────────────────────────────────────────────────────
function fetchPaperLatest() {
  return new Promise((resolve, reject) => {
    const get = (url, cb) => {
      https.get(url, { headers: { 'User-Agent': 'GamingBurst-Panel/1.0' } }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { cb(JSON.parse(d)); } catch (e) { reject(e); } });
      }).on('error', reject);
    };
    get('https://api.papermc.io/v2/projects/paper', (j) => {
      const latest = j.versions[j.versions.length - 1];
      get(`https://api.papermc.io/v2/projects/paper/versions/${latest}/builds`, (j2) => {
        const build   = j2.builds[j2.builds.length - 1];
        const jarName = build.downloads.application.name;
        resolve({
          version: latest,
          build:   build.build,
          jarName,
          url: `https://api.papermc.io/v2/projects/paper/versions/${latest}/builds/${build.build}/downloads/${jarName}`,
        });
      });
    });
  });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const get  = (u) => {
      https.get(u, { headers: { 'User-Agent': 'GamingBurst-Panel/1.0' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) return get(res.headers.location);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', (e) => { fs.unlink(destPath, () => {}); reject(e); });
    };
    get(url);
  });
}

// ── GET /api/servers ──────────────────────────────────────────────────────────
router.get('/servers', (req, res) => {
  const servers = getDb().prepare('SELECT * FROM servers ORDER BY created_at DESC').all();
  res.json(servers.map(s => ({ ...s, is_live: pm.isRunning(s.id) })));
});

// ── GET /api/servers/:id ──────────────────────────────────────────────────────
router.get('/servers/:id', (req, res) => {
  const server = getDb().prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  res.json({ ...server, is_live: pm.isRunning(server.id) });
});

// ── POST /api/servers — ADMIN ONLY ───────────────────────────────────────────
router.post('/servers', requireAdmin, async (req, res) => {
  try {
    const {
      name, mode = 'basic',
      port, memory_min, memory_max,
      jar_path, jvm_flags, env_tz, env_custom,
    } = req.body;

    if (!name?.trim()) return res.status(400).json({ error: 'Server name is required.' });

    const db        = getDb();
    const safeName  = name.trim().replace(/[^a-zA-Z0-9_\-]/g, '_');
    const serverDir = path.join(SERVERS_DIR, safeName);
    fs.mkdirSync(serverDir, { recursive: true });

    let finalPort      = port        ? parseInt(port, 10)        : pm.getNextAvailablePort();
    let finalMemMin    = memory_min  ? parseInt(memory_min, 10)  : 512;
    let finalMemMax    = memory_max  ? parseInt(memory_max, 10)  : 2048;
    let finalJar       = jar_path?.trim() || null;
    let finalJvmFlags  = jvm_flags?.trim() || '';
    let finalTz        = env_tz?.trim()    || (process.env.DEFAULT_TZ || 'Asia/Kolkata');
    let finalEnvCustom = env_custom?.trim()|| '{}';

    try { JSON.parse(finalEnvCustom); } catch {
      return res.status(400).json({ error: 'env_custom must be valid JSON.' });
    }

    if (mode === 'basic' || !finalJar) {
      // SSE stream for download progress
      res.writeHead(200, {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
      });
      const send = (msg) => res.write(`data: ${JSON.stringify({ msg })}\n\n`);
      send('Fetching latest PaperMC version...');
      const paper = await fetchPaperLatest();
      finalJar    = path.join(serverDir, paper.jarName);
      send(`Downloading PaperMC ${paper.version} build #${paper.build}...`);
      await downloadFile(paper.url, finalJar);
      send('Download complete. Creating server...');
      const info = db.prepare(`
        INSERT INTO servers (name,port,memory_min,memory_max,jar_path,jvm_flags,env_tz,env_custom,server_dir)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(safeName, finalPort, finalMemMin, finalMemMax, finalJar, finalJvmFlags, finalTz, finalEnvCustom, serverDir);
      send(`Server "${safeName}" ready on port ${finalPort}!`);
      res.write(`data: ${JSON.stringify({ done: true, id: info.lastInsertRowid })}\n\n`);
      return res.end();
    }

    // Advanced mode
    if (!fs.existsSync(finalJar)) {
      return res.status(400).json({ error: `JAR not found at: ${finalJar}` });
    }
    const info = db.prepare(`
      INSERT INTO servers (name,port,memory_min,memory_max,jar_path,jvm_flags,env_tz,env_custom,server_dir)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(safeName, finalPort, finalMemMin, finalMemMax, finalJar, finalJvmFlags, finalTz, finalEnvCustom, serverDir);
    res.json({ id: info.lastInsertRowid, name: safeName, port: finalPort });

  } catch (err) {
    console.error('[API] Create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/servers/:id — ADMIN ONLY ─────────────────────────────────────
router.delete('/servers/:id', requireAdmin, (req, res) => {
  const db     = getDb();
  const id     = parseInt(req.params.id, 10);
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  if (pm.isRunning(id)) return res.status(400).json({ error: 'Stop the server before deleting.' });
  db.prepare('DELETE FROM servers WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ── POST /api/servers/:id/start — any authenticated user ─────────────────────
router.post('/servers/:id/start', (req, res) => {
  try {
    const result = pm.startServer(parseInt(req.params.id, 10));
    res.json({ ok: true, pid: result.pid });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── POST /api/servers/:id/stop — any authenticated user ──────────────────────
router.post('/servers/:id/stop', (req, res) => {
  try {
    pm.stopServer(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── POST /api/servers/:id/restart — any authenticated user ───────────────────
router.post('/servers/:id/restart', (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    if (pm.isRunning(id)) pm.stopServer(id);
    // Re-start after a brief delay (let the process die first)
    setTimeout(() => {
      try { pm.startServer(id); } catch {}
    }, 2500);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── POST /api/servers/:id/command — ADMIN ONLY ───────────────────────────────
router.post('/servers/:id/command', requireAdmin, (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'Command required.' });
  try {
    pm.sendCommand(parseInt(req.params.id, 10), command.trim());
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── GET /api/servers/:id/logs — ADMIN ONLY ───────────────────────────────────
router.get('/servers/:id/logs', requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
  const logs  = getDb().prepare(`
    SELECT line, ts FROM server_logs
    WHERE server_id = ?
    ORDER BY id DESC LIMIT ?
  `).all(req.params.id, limit).reverse();
  res.json(logs);
});

// ── GET /api/status ───────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  const servers = getDb().prepare('SELECT id, name, status, port FROM servers').all();
  res.json({
    panel:   'online',
    servers: servers.map(s => ({ ...s, is_live: pm.isRunning(s.id) })),
  });
});

module.exports = router;
