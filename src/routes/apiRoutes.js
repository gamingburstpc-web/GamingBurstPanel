'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const https    = require('https');
const { requireAuth, requireAdmin, requirePermission, cookieMiddleware, hashPassword } = require('../auth');
const { getDb } = require('../db');
const pm = require('../processManager');

const router = express.Router();
router.use(cookieMiddleware);
router.use(requireAuth);

const SERVERS_DIR = path.resolve(process.env.SERVERS_DIR || './servers');

// ── GET /api/me — returns current user info (role etc.) ──────────────────────
router.get('/me', (req, res) => {
  res.json({
    id:          req.session.userId,
    username:    req.session.username,
    isAdmin:     req.session.isAdmin,
    permissions: req.session.permissions,
  });
});

// ── GET /api/users — ADMIN ONLY ──────────────────────────────────────────────
router.get('/users', requireAdmin, (req, res) => {
  const users = getDb().prepare('SELECT id, username, is_admin, permissions, created_at FROM users').all();
  res.json(users.map(u => ({
    ...u,
    permissions: JSON.parse(u.permissions || '[]')
  })));
});

// ── POST /api/users — ADMIN ONLY ─────────────────────────────────────────────
router.post('/users', requireAdmin, (req, res) => {
  const { username, password, is_admin, permissions } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
  if (existing) return res.status(400).json({ error: 'Username already exists.' });

  const hash = hashPassword(password);
  const permsJson = JSON.stringify(Array.isArray(permissions) ? permissions : []);
  const adminFlag = is_admin ? 1 : 0;

  try {
    const info = db.prepare(`
      INSERT INTO users (username, password, is_admin, permissions) VALUES (?, ?, ?, ?)
    `).run(username.trim(), hash, adminFlag, permsJson);
    res.json({ id: info.lastInsertRowid, username, is_admin: adminFlag, permissions: permsJson });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/users/:id — ADMIN ONLY ───────────────────────────────────────
router.delete('/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.session.userId) return res.status(400).json({ error: 'Cannot delete yourself.' });
  
  const db = getDb();
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ── PUT /api/users/:id — ADMIN ONLY ──────────────────────────────────────────
router.put('/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { username, password, is_admin, permissions } = req.body;
  if (!username?.trim()) return res.status(400).json({ error: 'Username is required.' });

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username.trim(), id);
  if (existing) return res.status(400).json({ error: 'Username already exists.' });

  const permsJson = JSON.stringify(Array.isArray(permissions) ? permissions : []);
  const adminFlag = is_admin ? 1 : 0;

  try {
    if (password && password.trim().length > 0) {
      const hash = hashPassword(password);
      db.prepare(`
        UPDATE users SET username = ?, password = ?, is_admin = ?, permissions = ? WHERE id = ?
      `).run(username.trim(), hash, adminFlag, permsJson, id);
    } else {
      db.prepare(`
        UPDATE users SET username = ?, is_admin = ?, permissions = ? WHERE id = ?
      `).run(username.trim(), adminFlag, permsJson, id);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PaperMC helpers ───────────────────────────────────────────────────────────
function fetchPaper(reqVersion = 'latest') {
  return new Promise((resolve, reject) => {
    const get = (url, cb) => {
      https.get(url, { headers: { 'User-Agent': 'GamingBurst-Panel/1.0' } }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { cb(JSON.parse(d)); } catch (e) { reject(e); } });
      }).on('error', reject);
    };
    get('https://api.papermc.io/v2/projects/paper', (j) => {
      let targetVersion = reqVersion;
      if (targetVersion === 'latest') {
        targetVersion = j.versions[j.versions.length - 1];
      } else if (!j.versions.includes(targetVersion)) {
        return reject(new Error(`Paper version ${targetVersion} not found.`));
      }
      get(`https://api.papermc.io/v2/projects/paper/versions/${targetVersion}/builds`, (j2) => {
        const build   = j2.builds[j2.builds.length - 1];
        const jarName = build.downloads.application.name;
        resolve({
          version: targetVersion,
          build:   build.build,
          jarName,
          url: `https://api.papermc.io/v2/projects/paper/versions/${targetVersion}/builds/${build.build}/downloads/${jarName}`,
        });
      });
    });
  });
}

function fetchVanilla(reqVersion = 'latest') {
  return new Promise((resolve, reject) => {
    const get = (url, cb) => {
      https.get(url, { headers: { 'User-Agent': 'GamingBurst-Panel/1.0' } }, (res) => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { cb(JSON.parse(d)); } catch (e) { reject(e); } });
      }).on('error', reject);
    };
    get('https://launchermeta.mojang.com/mc/game/version_manifest.json', (manifest) => {
      const targetVersion = reqVersion === 'latest' ? manifest.latest.release : reqVersion;
      const versionObj = manifest.versions.find(v => v.id === targetVersion);
      if (!versionObj) return reject(new Error(`Vanilla version ${targetVersion} not found.`));
      get(versionObj.url, (vManifest) => {
        if (!vManifest.downloads?.server) return reject(new Error(`No server download for Vanilla ${targetVersion}.`));
        resolve({
          version: targetVersion,
          url: vManifest.downloads.server.url,
          jarName: `vanilla-${targetVersion}.jar`
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
      platform = 'java', software = 'paper', version = 'latest',
      port, memory_min, memory_max,
      jar_path, jvm_flags, env_tz, env_custom,
    } = req.body;

    if (!name?.trim()) return res.status(400).json({ error: 'Server name is required.' });

    const db        = getDb();
    const safeName  = name.trim().replace(/[^a-zA-Z0-9_\-]/g, '_');
    const serverDir = path.join(SERVERS_DIR, safeName);
    fs.mkdirSync(serverDir, { recursive: true });

    let finalPort      = port        ? parseInt(port, 10)        : pm.getNextAvailablePort();
    let finalMemMin    = memory_min  ? parseInt(memory_min, 10)  : 1024;
    let finalMemMax    = memory_max  ? parseInt(memory_max, 10)  : 2048;
    let finalJar       = jar_path?.trim() || null;
    let finalJvmFlags  = jvm_flags?.trim() || '';
    let finalTz        = env_tz?.trim()    || (process.env.DEFAULT_TZ || 'Asia/Kolkata');
    let finalEnvCustom = env_custom?.trim()|| '{}';

    try { JSON.parse(finalEnvCustom); } catch {
      return res.status(400).json({ error: 'env_custom must be valid JSON.' });
    }

    if (!finalJar) {
      // Auto-download mode
      res.writeHead(200, {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
      });
      const send = (msg) => res.write(`data: ${JSON.stringify({ msg })}\n\n`);

      if (platform === 'bedrock') {
        send('Bedrock selected. Automated Bedrock download coming soon!');
        send('Please upload bedrock_server manually using the Files tab.');
        finalJar = path.join(serverDir, 'bedrock_server');
        // Touch the file so the DB record has a path
        fs.writeFileSync(finalJar, '#!/bin/bash\necho "Please replace me with actual bedrock_server"\n');
        fs.chmodSync(finalJar, 0o755);
      } else if (software === 'vanilla') {
        send(`Fetching Vanilla Minecraft version: ${version}...`);
        const vanilla = await fetchVanilla(version);
        finalJar = path.join(serverDir, vanilla.jarName);
        send(`Downloading Vanilla ${vanilla.version}...`);
        await downloadFile(vanilla.url, finalJar);
      } else {
        // Default PaperMC
        send(`Fetching PaperMC version: ${version}...`);
        const paper = await fetchPaper(version);
        finalJar    = path.join(serverDir, paper.jarName);
        send(`Downloading PaperMC ${paper.version} build #${paper.build}...`);
        await downloadFile(paper.url, finalJar);
      }

      send('Download complete. Creating server...');
      const info = db.prepare(`
        INSERT INTO servers (name,port,memory_min,memory_max,jar_path,jvm_flags,env_tz,env_custom,server_dir)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(safeName, finalPort, finalMemMin, finalMemMax, finalJar, finalJvmFlags, finalTz, finalEnvCustom, serverDir);
      send(`Server "${safeName}" ready on port ${finalPort}!`);
      res.write(`data: ${JSON.stringify({ done: true, id: info.lastInsertRowid })}\n\n`);
      return res.end();
    }

    // Advanced mode (manual JAR provided)
    if (!fs.existsSync(finalJar)) {
      return res.status(400).json({ error: `Executable not found at: ${finalJar}` });
    }
    const info = db.prepare(`
      INSERT INTO servers (name,port,memory_min,memory_max,jar_path,jvm_flags,env_tz,env_custom,server_dir)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(safeName, finalPort, finalMemMin, finalMemMax, finalJar, finalJvmFlags, finalTz, finalEnvCustom, serverDir);
    res.json({ id: info.lastInsertRowid, name: safeName, port: finalPort });

  } catch (err) {
    console.error('[API] Create error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
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

// ── POST /api/servers/:id/start ──────────────────────────────────────────────
router.post('/servers/:id/start', requirePermission('start'), (req, res) => {
  try {
    const result = pm.startServer(parseInt(req.params.id, 10));
    res.json({ ok: true, pid: result.pid });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── POST /api/servers/:id/stop ───────────────────────────────────────────────
router.post('/servers/:id/stop', requirePermission('stop'), (req, res) => {
  try {
    pm.stopServer(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── POST /api/servers/:id/restart ────────────────────────────────────────────
router.post('/servers/:id/restart', requirePermission('restart'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    if (pm.isRunning(id)) pm.stopServer(id);
    setTimeout(() => {
      try { pm.startServer(id); } catch {}
    }, 2500);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── POST /api/servers/:id/command ────────────────────────────────────────────
router.post('/servers/:id/command', requirePermission('console'), (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'Command required.' });
  try {
    pm.sendCommand(parseInt(req.params.id, 10), command.trim());
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── GET /api/servers/:id/logs ────────────────────────────────────────────────
router.get('/servers/:id/logs', requirePermission('console'), (req, res) => {
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

// ── File Manager Helpers ──────────────────────────────────────────────────────
function safePath(serverId, userPath) {
  const server = getDb().prepare('SELECT server_dir FROM servers WHERE id = ?').get(serverId);
  if (!server) throw new Error('Server not found');
  const baseDir = path.resolve(server.server_dir);
  const target  = path.resolve(baseDir, userPath || '');
  if (!target.startsWith(baseDir)) throw new Error('Invalid path: Directory traversal not allowed.');
  return { baseDir, target };
}

// ── GET /api/servers/:id/files ────────────────────────────────────────────────
router.get('/servers/:id/files', requirePermission('files'), (req, res) => {
  try {
    const { target } = safePath(req.params.id, req.query.path);
    if (!fs.existsSync(target)) return res.json([]);
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a directory' });

    const files = fs.readdirSync(target, { withFileTypes: true }).map(f => {
      const p = path.join(target, f.name);
      const s = fs.statSync(p);
      return {
        name: f.name,
        isDir: f.isDirectory(),
        size: s.size,
        modified: s.mtime
      };
    }).sort((a, b) => b.isDir - a.isDir || a.name.localeCompare(b.name));
    res.json(files);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── GET /api/servers/:id/files/content ────────────────────────────────────────
router.get('/servers/:id/files/content', requirePermission('files'), (req, res) => {
  try {
    const { target } = safePath(req.params.id, req.query.path);
    if (!fs.existsSync(target)) return res.status(404).json({ error: 'File not found' });
    if (fs.statSync(target).isDirectory()) return res.status(400).json({ error: 'Cannot read directory content' });
    res.send(fs.readFileSync(target, 'utf8'));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── PUT /api/servers/:id/files/content ────────────────────────────────────────
router.put('/servers/:id/files/content', requirePermission('files'), express.text({ limit: '5mb' }), (req, res) => {
  try {
    const { target } = safePath(req.params.id, req.query.path);
    fs.writeFileSync(target, req.body || '');
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── DELETE /api/servers/:id/files ─────────────────────────────────────────────
router.delete('/servers/:id/files', requirePermission('files'), (req, res) => {
  try {
    const { baseDir, target } = safePath(req.params.id, req.query.path);
    if (target === baseDir) return res.status(400).json({ error: 'Cannot delete root server directory' });
    if (!fs.existsSync(target)) return res.status(404).json({ error: 'Not found' });
    fs.rmSync(target, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
