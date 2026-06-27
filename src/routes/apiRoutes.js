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

// ── GET /api/ping ─────────────────────────────────────────────────────────────
router.get('/ping', (req, res) => res.send('pong'));

// ── CLI Database Proxy ────────────────────────────────────────────────────────
// Allows the gbpanel CLI tool to execute queries while the web panel holds the SQLite lock.
router.post('/cli', express.json(), (req, res) => {
  if (req.ip !== '127.0.0.1' && req.ip !== '::1' && req.ip !== '::ffff:127.0.0.1') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const { method, sql, args } = req.body;
    const db = require('../db').getDb();
    const result = db.prepare(sql)[method](...args);
    res.json({ result });
  } catch (err) {
    res.json({ error: err.message });
  }
});

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
function getJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'GamingBurst-Panel/1.0' } }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function fetchPaper(reqVersion = 'latest') {
  // Provider 1: Official Paper API
  const officialApi = async () => {
    const j = await getJSON('https://api.papermc.io/v2/projects/paper');
    let targetVersion = reqVersion;
    if (targetVersion === 'latest') {
      targetVersion = j.versions[j.versions.length - 1];
    } else if (!j.versions.includes(targetVersion)) {
      throw new Error(`Version not listed on Official API`);
    }
    const j2 = await getJSON(`https://api.papermc.io/v2/projects/paper/versions/${targetVersion}/builds`);
    const build   = j2.builds[j2.builds.length - 1];
    const jarName = build.downloads.application.name;
    return {
      version: targetVersion,
      build:   build.build,
      jarName,
      url: `https://api.papermc.io/v2/projects/paper/versions/${targetVersion}/builds/${build.build}/downloads/${jarName}`
    };
  };

  // Add more fallback providers here in the future
  const providers = [officialApi];

  for (const provider of providers) {
    try {
      return await provider();
    } catch (e) {
      console.warn(`Paper provider failed for ${reqVersion}:`, e.message);
      // continue to next provider
    }
  }

  throw new Error('VERSION_NOT_FOUND');
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
function getDirSizeSync(dirPath) {
  let size = 0;
  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const item of items) {
      const p = path.join(dirPath, item.name);
      if (item.isDirectory()) size += getDirSizeSync(p);
      else size += fs.statSync(p).size;
    }
  } catch(e) {}
  return size;
}

function getVpsDiskInfo() {
  try {
    const stat = fs.statfsSync('/');
    const total = stat.blocks * stat.bsize;
    const free = stat.bavail * stat.bsize;
    return { total, used: total - free };
  } catch(e) { return { total: 0, used: 0 }; }
}

router.get('/servers/:id', (req, res) => {
  const server = getDb().prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  const disk_usage = getDirSizeSync(server.server_dir);
  const vpsDisk = getVpsDiskInfo();
  res.json({ 
    ...server, 
    is_live: pm.isRunning(server.id), 
    disk_usage,
    vps_disk_total: vpsDisk.total,
    vps_disk_used: vpsDisk.used,
    vps_ram_total: require('os').totalmem(),
    vps_ram_used: require('os').totalmem() - require('os').freemem()
  });
});

// ── POST /api/servers — ADMIN ONLY ───────────────────────────────────────────
router.post('/servers', requireAdmin, async (req, res) => {
  try {
    const {
      name, mode = 'basic',
      platform = 'java', software = 'paper', version = 'latest',
      port, memory_min, memory_max,
      jar_path, jvm_flags, env_tz, env_custom,
      download_url // Custom fallback URL
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
      const send = (msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`);

      try {
        if (download_url) {
          send({ msg: `Fetching from Direct URL...` });
          finalJar = path.join(serverDir, `custom-${Date.now()}.jar`);
          await downloadFile(download_url, finalJar);
        } else if (platform === 'bedrock') {
          send({ msg: 'Bedrock selected. Automated Bedrock download coming soon!' });
          send({ msg: 'Please upload bedrock_server manually using the Files tab.' });
          finalJar = path.join(serverDir, 'bedrock_server');
          fs.writeFileSync(finalJar, '#!/bin/bash\necho "Please replace me with actual bedrock_server"\n');
          fs.chmodSync(finalJar, 0o755);
        } else if (software === 'vanilla') {
          send({ msg: `Fetching Vanilla Minecraft version: ${version}...` });
          const vanilla = await fetchVanilla(version);
          finalJar = path.join(serverDir, vanilla.jarName);
          send({ msg: `Downloading Vanilla ${vanilla.version}...` });
          await downloadFile(vanilla.url, finalJar);
        } else {
          // Default PaperMC
          send({ msg: `Fetching PaperMC version: ${version}...` });
          const paper = await fetchPaper(version);
          finalJar    = path.join(serverDir, paper.jarName);
          send({ msg: `Downloading PaperMC ${paper.version} build #${paper.build}...` });
          await downloadFile(paper.url, finalJar);
        }
      } catch (err) {
        if (err.message === 'VERSION_NOT_FOUND') {
          res.write(`data: ${JSON.stringify({ action: 'PROMPT_FALLBACK', version })}\n\n`);
          return res.end();
        }
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        return res.end();
      }

      send({ msg: 'Download complete. Creating server...' });
      const info = db.prepare(`
        INSERT INTO servers (name,port,memory_min,memory_max,jar_path,jvm_flags,env_tz,env_custom,server_dir)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(safeName, finalPort, finalMemMin, finalMemMax, finalJar, finalJvmFlags, finalTz, finalEnvCustom, serverDir);
      send({ msg: `Server "${safeName}" ready on port ${finalPort}!` });
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

// ── DELETE /api/servers/:id ──────────────────────────────────────────────────
router.delete('/servers/:id', requirePermission('delete'), (req, res) => {
  const db     = getDb();
  const id     = parseInt(req.params.id, 10);
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  if (pm.isRunning(id)) return res.status(400).json({ error: 'Stop the server before deleting.' });

  // Completely wipe server directory on disk to free storage
  if (server.server_dir && fs.existsSync(server.server_dir)) {
    try {
      fs.rmSync(server.server_dir, { recursive: true, force: true });
    } catch (e) {
      console.error(`[API] Failed to delete server directory ${server.server_dir}:`, e.message);
    }
  }

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
      const isDir = f.isDirectory();
      return {
        name: f.name,
        isDir: isDir,
        size: isDir ? getDirSizeSync(p) : s.size,
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

// ── POST /api/servers/:id/files/upload ────────────────────────────────────────
router.post('/servers/:id/files/upload', requirePermission('files'), express.raw({ type: '*/*', limit: '500mb' }), (req, res) => {
  try {
    const { target } = safePath(req.params.id, req.query.path);
    fs.writeFileSync(target, req.body);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── POST /api/servers/:id/plugins/download-url ──────────────────────────────
router.post('/servers/:id/plugins/download-url', requirePermission('files'), express.json(), async (req, res) => {
  try {
    const { url, filename } = req.body;
    if (!url || !filename) return res.status(400).json({ error: 'Missing url or filename' });
    
    // safePath for plugins/filename
    const { target } = safePath(req.params.id, 'plugins/' + filename);
    if (!fs.existsSync(path.dirname(target))) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
    }
    
    // Create write stream
    const dest = fs.createWriteStream(target);
    const downloadClient = url.startsWith('https') ? https : require('http');
    
    await new Promise((resolve, reject) => {
      downloadClient.get(url, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          // Handle one redirect
          const redirectClient = response.headers.location.startsWith('https') ? https : require('http');
          redirectClient.get(response.headers.location, (redirRes) => {
             redirRes.pipe(dest);
             redirRes.on('end', resolve);
             redirRes.on('error', reject);
          }).on('error', reject);
        } else {
          response.pipe(dest);
          response.on('end', resolve);
          response.on('error', reject);
        }
      }).on('error', reject);
    });
    
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

// ── GET /api/servers/:id/files/download ───────────────────────────────────────
router.get('/servers/:id/files/download', requirePermission('files'), (req, res) => {
  try {
    const { target } = safePath(req.params.id, req.query.path);
    if (!fs.existsSync(target)) return res.status(404).json({ error: 'File not found' });
    if (fs.statSync(target).isDirectory()) return res.status(400).json({ error: 'Cannot download directory' });
    res.download(target);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── POST /api/servers/:id/files/archive ───────────────────────────────────────
router.post('/servers/:id/files/archive', requirePermission('files'), (req, res) => {
  const { execFile } = require('child_process');
  try {
    const { action, path: userPath } = req.body;
    if (!action || !userPath) return res.status(400).json({ error: 'Action and path required.' });

    const { baseDir, target } = safePath(req.params.id, userPath);
    const parentDir = path.dirname(target);
    const baseName  = path.basename(target);

    if (action === 'compress') {
      const archiveName = `${baseName}.tar.gz`;
      const archivePath = path.join(parentDir, archiveName);
      execFile('tar', ['-czf', archivePath, '-C', parentDir, baseName], (err) => {
        if (err) return res.status(500).json({ error: `Compression failed: ${err.message}` });
        res.json({ ok: true, archive: archiveName });
      });
    } else if (action === 'decompress') {
      const isTar = target.endsWith('.tar.gz') || target.endsWith('.tgz');
      const isZip = target.endsWith('.zip');

      if (isTar) {
        execFile('tar', ['-xzf', target, '-C', parentDir], (err) => {
          if (err) return res.status(500).json({ error: `Decompression failed: ${err.message}` });
          res.json({ ok: true });
        });
      } else if (isZip) {
        execFile('tar', ['-xf', target, '-C', parentDir], (err) => {
          if (err) return res.status(500).json({ error: `Extraction failed: ${err.message}` });
          res.json({ ok: true });
        });
      } else {
        res.status(400).json({ error: 'Unsupported archive type. Use .zip, .tar.gz, or .tgz.' });
      }
    } else {
      res.status(400).json({ error: 'Invalid action' });
    }
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Playit API Endpoints ───────────────────────────────────────────────────────
const playitManager = require('../playitManager');

router.get('/servers/:id/playit/status', requirePermission('files'), (req, res) => {
  try {
    const server = getDb().prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    const status = playitManager.getStatus(server.id, server.server_dir);
    res.json(status);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/servers/:id/playit/download', requirePermission('files'), async (req, res) => {
  try {
    const server = getDb().prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    await playitManager.downloadPlayit(server.server_dir);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/servers/:id/playit/claim', requirePermission('files'), (req, res) => {
  try {
    const server = getDb().prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    playitManager.setupClaim(server.id, server.server_dir);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/servers/:id/playit/secret', requirePermission('files'), (req, res) => {
  try {
    const server = getDb().prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (!req.body.secret) return res.status(400).json({ error: 'Secret required' });
    playitManager.setupSecret(server.id, server.server_dir, req.body.secret);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/servers/:id/playit/reset', requirePermission('files'), (req, res) => {
  try {
    const server = getDb().prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    playitManager.resetPlayit(server.id, server.server_dir);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PLAYERS MANAGEMENT ────────────────────────────────────────────────────────

router.get('/servers/:id/players', requirePermission('console'), async (req, res) => {
  const serverId = req.params.id;
  if (!pm.isRunning(serverId)) return res.json({ players: [] });
  const emitter = pm.getEmitter(serverId);
  if (!emitter) return res.json({ players: [] });

  return new Promise((resolve) => {
    let timeout = setTimeout(() => {
      emitter.off('line', onLine);
      resolve(res.json({ players: [] }));
    }, 5000);

    let foundList = false;
    const onLine = (rawLine) => {
      // Strip ANSI codes for easier parsing
      const line = rawLine.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
      const lower = line.toLowerCase();
      
      if (lower.includes('players online') || lower.includes('online players') || lower.match(/there are .* online/)) {
        const parts = line.split(':');
        if (parts.length > 1 && parts[parts.length - 1].trim().length > 0) {
          // If the line has a colon, assume everything after the LAST colon is the player list
          const p = parts[parts.length - 1].split(',').map(x => x.trim().replace(/§[0-9a-fk-or]/ig, '')).filter(Boolean);
          // Only resolve if it actually found players, otherwise it might be a prefix line like Essentials
          if (p.length > 0 && !p[0].toLowerCase().includes('out of maximum')) {
            clearTimeout(timeout);
            emitter.off('line', onLine);
            resolve(res.json({ players: p }));
            return;
          }
        }
        foundList = true;
      } else if (foundList) {
        // This is the next line after the header (used by some plugins like Essentials)
        // Extract everything after the last colon, or just use the line if no colon
        let playerStr = line;
        if (line.includes(':')) {
           const parts = line.split(':');
           playerStr = parts[parts.length - 1];
        }
        const p = playerStr.split(',').map(x => x.trim().replace(/§[0-9a-fk-or]/ig, '')).filter(Boolean);
        clearTimeout(timeout);
        emitter.off('line', onLine);
        resolve(res.json({ players: p }));
      }
    };
    emitter.on('line', onLine);
    pm.sendCommand(serverId, 'list');
  });
});

router.post('/servers/:id/players/command', requirePermission('console'), express.json(), (req, res) => {
  const { action, player } = req.body;
  let cmd = '';
  if (action === 'kick') cmd = `kick ${player}`;
  else if (action === 'ban') cmd = `ban ${player}`;
  else if (action === 'unban') cmd = `pardon ${player}`;
  else if (action === 'whitelist_add') cmd = `whitelist add ${player}`;
  else if (action === 'whitelist_remove') cmd = `whitelist remove ${player}`;
  else if (action === 'whitelist_on') cmd = `whitelist on`;
  else if (action === 'whitelist_off') cmd = `whitelist off`;
  
  if (cmd) pm.sendCommand(req.params.id, cmd);

  // Force update server.properties for UI feedback
  if (action === 'whitelist_on' || action === 'whitelist_off') {
    const server = getDb().prepare('SELECT server_dir FROM servers WHERE id = ?').get(req.params.id);
    if (server) {
      const propsPath = require('path').join(server.server_dir, 'server.properties');
      if (require('fs').existsSync(propsPath)) {
        let props = require('fs').readFileSync(propsPath, 'utf8');
        if (action === 'whitelist_on') {
          if (/white-list\s*=\s*(false|true)/.test(props)) {
            props = props.replace(/white-list\s*=\s*(false|true)/g, 'white-list=true');
          } else {
            props += '\nwhite-list=true\n';
          }
        } else {
          if (/white-list\s*=\s*(false|true)/.test(props)) {
            props = props.replace(/white-list\s*=\s*(false|true)/g, 'white-list=false');
          } else {
            props += '\nwhite-list=false\n';
          }
        }
        require('fs').writeFileSync(propsPath, props);
      }
    }
  }

  res.json({ ok: true });
});

router.get('/servers/:id/players/lists', requirePermission('console'), (req, res) => {
  const server = getDb().prepare('SELECT server_dir FROM servers WHERE id = ?').get(req.params.id);
  let banned = [], whitelist = [];
  try {
    const bFile = path.join(server.server_dir, 'banned-players.json');
    if (fs.existsSync(bFile)) banned = JSON.parse(fs.readFileSync(bFile, 'utf8'));
  } catch(e) {}
  try {
    const wFile = path.join(server.server_dir, 'whitelist.json');
    if (fs.existsSync(wFile)) whitelist = JSON.parse(fs.readFileSync(wFile, 'utf8'));
  } catch(e) {}
  
  let whitelistEnabled = false;
  try {
    const props = fs.readFileSync(path.join(server.server_dir, 'server.properties'), 'utf8');
    whitelistEnabled = props.includes('white-list=true');
  } catch(e) {}

  res.json({ banned, whitelist, whitelistEnabled });
});

router.post('/servers/:id/players/coordinates', requirePermission('console'), express.json(), async (req, res) => {
  const { player } = req.body;
  const serverId = req.params.id;
  if (!pm.isRunning(serverId)) return res.json({ error: 'Server offline' });
  const emitter = pm.getEmitter(serverId);
  if (!emitter) return res.json({ error: 'No emitter' });

  return new Promise((resolve) => {
    let timeout = setTimeout(() => {
      emitter.off('line', onLine);
      resolve(res.json({ error: 'Not supported on Bedrock or player missing.' }));
    }, 1500);

    const onLine = (line) => {
      if (line.includes('has the following entity data:')) {
        const match = line.match(/\[(.*?)\]/);
        if (match) {
          clearTimeout(timeout);
          emitter.off('line', onLine);
          // format [-123.45d, 64.0d, 567.89d] to X: -123, Y: 64, Z: 567
          let coords = match[1].replace(/d/g, '').split(',').map(n => Math.round(parseFloat(n)));
          if (coords.length === 3) resolve(res.json({ coordinates: `X: ${coords[0]}, Y: ${coords[1]}, Z: ${coords[2]}` }));
          else resolve(res.json({ coordinates: match[1] }));
        }
      }
    };
    emitter.on('line', onLine);
    pm.sendCommand(serverId, `data get entity ${player} Pos`);
  });
});

// ── SERVER SETTINGS ───────────────────────────────────────────────────────────
router.get('/servers/:id/settings', requirePermission('console'), (req, res) => {
  const server = getDb().prepare('SELECT server_dir FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  
  let motd = '';
  let onlineMode = true;
  let antiXray = false;
  let antiXrayEngine = 1;

  try {
    const propsPath = path.join(server.server_dir, 'server.properties');
    if (fs.existsSync(propsPath)) {
      const props = fs.readFileSync(propsPath, 'utf8');
      const motdMatch = props.match(/^motd=(.*)$/m);
      if (motdMatch) motd = motdMatch[1].trim();
      const onlineMatch = props.match(/^online-mode=(true|false)$/m);
      if (onlineMatch) onlineMode = onlineMatch[1] === 'true';
    }
  } catch(e) {}

  try {
    const paperPath = path.join(server.server_dir, 'config', 'paper-world-defaults.yml');
    if (fs.existsSync(paperPath)) {
      const paperYml = fs.readFileSync(paperPath, 'utf8');
      const xrayMatch = paperYml.match(/anti-xray:\s*[\r\n]+(?:\s*#.*[\r\n]+)*\s*enabled:\s*(true|false)/);
      if (xrayMatch) antiXray = xrayMatch[1] === 'true';
      const engineMatch = paperYml.match(/engine-mode:\s*([12])/);
      if (engineMatch) antiXrayEngine = parseInt(engineMatch[1], 10);
    }
  } catch(e) {}

  res.json({ motd, onlineMode, antiXray, antiXrayEngine });
});

router.post('/servers/:id/settings/properties', requirePermission('console'), express.json(), (req, res) => {
  const server = getDb().prepare('SELECT server_dir FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  
  const { motd, onlineMode } = req.body;
  try {
    const propsPath = path.join(server.server_dir, 'server.properties');
    if (fs.existsSync(propsPath)) {
      let props = fs.readFileSync(propsPath, 'utf8');
      if (motd !== undefined) {
        if (/^motd=.*$/m.test(props)) props = props.replace(/^motd=.*$/m, `motd=${motd}`);
        else props += `\nmotd=${motd}\n`;
      }
      if (onlineMode !== undefined) {
        if (/^online-mode=(true|false)$/m.test(props)) props = props.replace(/^online-mode=(true|false)$/m, `online-mode=${onlineMode}`);
        else props += `\nonline-mode=${onlineMode}\n`;
      }
      fs.writeFileSync(propsPath, props);
    }
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/settings/antixray', requirePermission('console'), express.json(), (req, res) => {
  const server = getDb().prepare('SELECT server_dir FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  
  const { enabled, engine } = req.body;
  try {
    const paperDir = path.join(server.server_dir, 'config');
    const paperPath = path.join(paperDir, 'paper-world-defaults.yml');
    
    if (fs.existsSync(paperPath)) {
      let paperYml = fs.readFileSync(paperPath, 'utf8');
      
      const xrayBlockRegex = /(anti-xray:\s*[\r\n]+(?:\s*#.*[\r\n]+)*\s*enabled:\s*)(true|false)/;
      if (xrayBlockRegex.test(paperYml)) {
        paperYml = paperYml.replace(xrayBlockRegex, `$1${enabled ? 'true' : 'false'}`);
      }
      
      if (engine !== undefined) {
        const engineRegex = /(anti-xray:[\s\S]*?engine-mode:\s*)([12])/;
        if (engineRegex.test(paperYml)) {
          paperYml = paperYml.replace(engineRegex, `$1${engine}`);
        }
      }
      fs.writeFileSync(paperPath, paperYml);
    }
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/settings/logo', requirePermission('files'), express.json({limit: '5mb'}), (req, res) => {
  const server = getDb().prepare('SELECT server_dir FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  
  const { image } = req.body;
  if (!image || !image.startsWith('data:image/png;base64,')) {
    return res.status(400).json({ error: 'Invalid image data' });
  }
  
  try {
    const base64Data = image.replace(/^data:image\/png;base64,/, "");
    const logoPath = path.join(server.server_dir, 'server-icon.png');
    fs.writeFileSync(logoPath, base64Data, 'base64');
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/settings/version', requirePermission('console'), express.json(), async (req, res) => {
  const server = getDb().prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  
  const { type, value } = req.body;
  if (!value) return res.status(400).json({ error: 'Version or URL is required' });
  
  try {
    let finalJar = '';
    if (type === 'url') {
      finalJar = path.join(server.server_dir, `custom-${Date.now()}.jar`);
      await downloadFile(value, finalJar);
    } else {
      const paper = await fetchPaper(value);
      finalJar = path.join(server.server_dir, paper.jarName);
      await downloadFile(paper.url, finalJar);
    }
    
    getDb().prepare('UPDATE servers SET jar_path = ? WHERE id = ?').run(finalJar, server.id);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
