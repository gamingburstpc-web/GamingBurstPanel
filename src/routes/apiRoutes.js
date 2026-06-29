'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const https    = require('https');
const crypto   = require('crypto');
const AdmZip   = require('adm-zip');
const { requireAuth, requireAdmin, requirePermission, cookieMiddleware, hashPassword, updateUserSessions, destroyUserSessions } = require('../auth');
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
  res.json(users.map(u => {
    let p = [];
    try { p = JSON.parse(u.permissions || '[]'); } catch {}
    if (Array.isArray(p)) p = { global: p, servers: {} };
    return { ...u, permissions: p };
  }));
});

// ── POST /api/users — ADMIN ONLY ─────────────────────────────────────────────
router.post('/users', requireAdmin, (req, res) => {
  const { username, password, is_admin, permissions } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
  if (existing) return res.status(400).json({ error: 'Username already exists.' });

  const hash = hashPassword(password);
  let permsObj = { global: [], servers: {} };
  if (permissions) {
    if (Array.isArray(permissions)) permsObj.global = permissions;
    else if (typeof permissions === 'object') permsObj = permissions;
  }
  const permsJson = JSON.stringify(permsObj);
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
  if (id === 1) return res.status(403).json({ error: 'The primary owner (User #1) cannot be deleted.' });
  if (id === req.session.userId) return res.status(400).json({ error: 'Cannot delete yourself.' });
  
  const db = getDb();
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  
  destroyUserSessions(id);
  
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
  
  if (id === 1 && req.session.userId !== 1) {
    return res.status(403).json({ error: 'Only the primary owner can modify their own account.' });
  }

  let permsObj = { global: [], servers: {} };
  if (permissions) {
    if (Array.isArray(permissions)) permsObj.global = permissions;
    else if (typeof permissions === 'object') permsObj = permissions;
  }
  const permsJson = JSON.stringify(permsObj);
  let adminFlag = is_admin ? 1 : 0;
  
  if (id === 1) {
    adminFlag = 1; // Primary owner is always an admin
  }

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

    updateUserSessions(id, {
      username: username.trim(),
      isAdmin: adminFlag === 1,
      permissions: permsObj
    });

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
  let servers = getDb().prepare('SELECT * FROM servers ORDER BY created_at DESC').all();
  
  if (!req.session.isAdmin) {
    const p = req.session.permissions || { global: [], servers: {} };
    const perms = Array.isArray(p) ? { global: p, servers: {} } : p;
    
    servers = servers.filter(s => {
      return (perms.global && perms.global.length > 0) || 
             (perms.servers && perms.servers[s.id] && perms.servers[s.id].length > 0);
    });
  }
  
  res.json(servers.map(s => {
    const isLive = pm.isRunning(s.id);
    let out = {
      ...s,
      is_live: isLive,
      status: isLive ? (s.status === 'starting' ? 'starting' : 'running') : s.status
    };
    if (req.session.isAdmin) {
      out.owner_id = s.owner_id;
      out.expire_at = s.expire_at;
      out.delete_at = s.delete_at;
    }
    return out;
  }));
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
  const isLive = pm.isRunning(server.id);
  
  let responseData = { 
    ...server, 
    is_live: isLive, 
    status: isLive ? (server.status === 'starting' ? 'starting' : 'running') : server.status,
    disk_usage,
    is_expired: server.expire_at ? Date.now() > server.expire_at : false,
    delete_at: server.delete_at
  };
  
  if (req.session.isAdmin) {
    const vpsDisk = getVpsDiskInfo();
    responseData.vps_disk_total = vpsDisk.total;
    responseData.vps_disk_used = vpsDisk.used;
    responseData.vps_ram_total = require('os').totalmem();
    responseData.vps_ram_used = require('os').totalmem() - require('os').freemem();
  }
  
  res.json(responseData);
});

// ── POST /api/rentals/:id — ADMIN ONLY ───────────────────────────────────────
router.post('/rentals/:id', requireAdmin, (req, res) => {
  const serverId = parseInt(req.params.id, 10);
  const { owner_id, expire_at, delete_at, perms } = req.body;
  
  try {
    const db = getDb();
    
    // 1. Update server
    const server = db.prepare('SELECT owner_id FROM servers WHERE id = ?').get(serverId);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    
    const targetOwner = owner_id ? parseInt(owner_id, 10) : null;
    
    // Build update query dynamically
    let updates = ['owner_id = ?'];
    let params = [targetOwner];
    
    if (expire_at !== undefined) {
      updates.push('expire_at = ?');
      params.push(expire_at);
    }
    if (delete_at !== undefined) {
      updates.push('delete_at = ?');
      params.push(delete_at);
    }
    
    params.push(serverId);
    
    db.prepare(`UPDATE servers SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    
    // 2. Clear old owner's permissions for this server if owner changed
    if (server.owner_id && server.owner_id !== targetOwner) {
      const oldUser = db.prepare('SELECT permissions FROM users WHERE id = ?').get(server.owner_id);
      if (oldUser) {
        let p = { global: [], servers: {} };
        try { p = JSON.parse(oldUser.permissions || '[]'); } catch {}
        if (Array.isArray(p)) p = { global: p, servers: {} };
        if (p.servers && p.servers[serverId]) {
          delete p.servers[serverId];
          db.prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(p), server.owner_id);
          updateUserSessions(server.owner_id, { permissions: p });
        }
      }
    }
    
    // 3. Set new owner's permissions
    if (targetOwner) {
      const newUser = db.prepare('SELECT permissions FROM users WHERE id = ?').get(targetOwner);
      if (newUser) {
        let p = { global: [], servers: {} };
        try { p = JSON.parse(newUser.permissions || '[]'); } catch {}
        if (Array.isArray(p)) p = { global: p, servers: {} };
        
        p.servers[serverId] = Array.isArray(perms) ? perms : [];
        db.prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(p), targetOwner);
        updateUserSessions(targetOwner, { permissions: p });
      }
    }
    
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    const db = getDb();
    const server = db.prepare('SELECT expire_at FROM servers WHERE id = ?').get(req.params.id);
    if (server && server.expire_at && Date.now() > server.expire_at) {
      return res.status(403).json({ error: 'Subscription ended. Cannot start server.' });
    }
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
    const db = getDb();
    const server = db.prepare('SELECT expire_at FROM servers WHERE id = ?').get(id);
    if (server && server.expire_at && Date.now() > server.expire_at) {
      return res.status(403).json({ error: 'Subscription ended. Cannot restart server.' });
    }
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

// ── POST /api/servers/:id/plugins/download-url ────────────────────────────────
router.post('/servers/:id/plugins/download-url', requirePermission('plugins'), express.json(), async (req, res) => {
  try {
    const { url, filename, validateLoader } = req.body;
    if (!url || !filename) return res.status(400).json({ error: 'Missing url or filename' });
    
    let finalFilename = filename;
    let finalTarget = '';
    
    await new Promise((resolve, reject) => {
      const handleResponse = (res, urlUsed) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, urlUsed).href;
          const redirectClient = redirectUrl.startsWith('https') ? https : require('http');
          redirectClient.get(redirectUrl, (redirRes) => handleResponse(redirRes, redirectUrl)).on('error', reject);
          return;
        }
        
        if (res.statusCode !== 200) return reject(new Error('Download failed with status ' + res.statusCode));
        
        // Try to get filename from Content-Disposition
        let cdFilename = null;
        const cd = res.headers['content-disposition'];
        if (cd) {
          const matchStar = cd.match(/filename\*=UTF-8''([^;]+)/i);
          if (matchStar && matchStar[1]) {
            cdFilename = decodeURIComponent(matchStar[1]);
          } else {
            const match = cd.match(/filename="?([^"]+)"?/i);
            if (match && match[1]) {
              cdFilename = match[1];
              // Remove RFC 2047 encoding if present
              if (cdFilename.startsWith('=?UTF-8?Q?') && cdFilename.endsWith('?=')) {
                cdFilename = cdFilename.replace('=?UTF-8?Q?', '').replace('?=', '');
              }
            }
          }
        }
        
        if (cdFilename) {
          // Sanitize filename for Windows
          finalFilename = cdFilename.replace(/[<>:"/\\|?*]/g, '_');
        } else {
          // Try to guess from the final URL path if it has .jar
          const urlPath = new URL(urlUsed).pathname;
          const nameFromUrl = urlPath.split('/').pop();
          if (nameFromUrl && nameFromUrl.endsWith('.jar')) {
             finalFilename = nameFromUrl;
          }
        }
        
        const { target } = safePath(req.params.id, 'plugins/' + finalFilename);
        finalTarget = target;
        
        if (!fs.existsSync(path.dirname(finalTarget))) {
          fs.mkdirSync(path.dirname(finalTarget), { recursive: true });
        }
        
        const dest = fs.createWriteStream(finalTarget);
        res.pipe(dest);
        dest.on('finish', () => resolve());
        res.on('error', reject);
        dest.on('error', reject);
      };
      
      const downloadClient = url.startsWith('https') ? https : require('http');
      downloadClient.get(url, (res) => handleResponse(res, url)).on('error', reject);
    });
    
    // Post-download validation using adm-zip
    if (validateLoader) {
      try {
        const zip = new AdmZip(finalTarget);
        const zipEntries = zip.getEntries().map(e => e.entryName);
        
        let isValid = false;
        const loaderLower = validateLoader.toLowerCase();
        
        if (loaderLower === 'paper' || loaderLower === 'spigot' || loaderLower === 'bukkit') {
          if (zipEntries.includes('plugin.yml')) isValid = true;
        } else if (loaderLower === 'velocity') {
          if (zipEntries.includes('velocity-plugin.json')) isValid = true;
        } else if (loaderLower === 'bungeecord' || loaderLower === 'waterdogpe') {
          if (zipEntries.includes('bungee.yml')) isValid = true;
        } else {
          // Unsupported loader for strict validation, assume valid or ignore
          isValid = true;
        }
        
        if (!isValid) {
          // Validation failed, delete the file
          fs.unlinkSync(finalTarget);
          return res.status(400).json({ error: 'Validation failed: Missing manifest for ' + validateLoader });
        }
      } catch (err) {
        fs.unlinkSync(finalTarget);
        return res.status(400).json({ error: 'Validation failed: Could not read archive' });
      }
    }
    
    res.json({ ok: true, filename: finalFilename });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/servers/:id/files ─────────────────────────────────────────────
router.delete('/servers/:id/files', requirePermission('files'), express.json(), (req, res) => {
  try {
    let paths = req.body.paths;
    if (!paths && req.query.path) paths = [req.query.path];
    if (!paths || !Array.isArray(paths)) return res.status(400).json({ error: 'Paths array required' });

    for (const p of paths) {
      const { baseDir, target } = safePath(req.params.id, p);
      if (target === baseDir) continue; // Skip root
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── POST /api/servers/:id/files/rename ────────────────────────────────────────
router.post('/servers/:id/files/rename', requirePermission('files'), express.json(), (req, res) => {
  try {
    const { oldPath, newPath } = req.body;
    if (!oldPath || !newPath) return res.status(400).json({ error: 'Paths required' });
    const oldTarget = safePath(req.params.id, oldPath).target;
    const newTarget = safePath(req.params.id, newPath).target;
    if (!fs.existsSync(oldTarget)) return res.status(404).json({ error: 'Source not found' });
    fs.renameSync(oldTarget, newTarget);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── POST /api/servers/:id/files/move ──────────────────────────────────────────
router.post('/servers/:id/files/move', requirePermission('files'), express.json(), (req, res) => {
  try {
    let { oldPath, newPath, paths, newDir } = req.body;
    
    // Legacy single move
    if (oldPath && newPath) {
      const oldTarget = safePath(req.params.id, oldPath).target;
      const newTarget = safePath(req.params.id, newPath).target;
      if (!fs.existsSync(oldTarget)) return res.status(404).json({ error: 'Source not found' });
      const destDir = path.dirname(newTarget);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      fs.renameSync(oldTarget, newTarget);
      return res.json({ ok: true });
    }
    
    // Bulk move
    if (!paths || !Array.isArray(paths) || newDir === undefined) {
      return res.status(400).json({ error: 'paths array and newDir required' });
    }
    
    for (const p of paths) {
      const oldTarget = safePath(req.params.id, p).target;
      const filename = path.basename(oldTarget);
      const newTarget = safePath(req.params.id, newDir ? `${newDir}/${filename}` : filename).target;
      
      if (fs.existsSync(oldTarget)) {
        const destDir = path.dirname(newTarget);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        fs.renameSync(oldTarget, newTarget);
      }
    }
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
router.post('/servers/:id/files/archive', requirePermission('files'), express.json(), (req, res) => {
  const { execFile } = require('child_process');
  try {
    let { action, path: userPath, paths } = req.body;
    if (!action) return res.status(400).json({ error: 'Action required.' });

    // Bulk archive (only compress supported)
    if (paths && Array.isArray(paths) && action === 'compress') {
      if (paths.length === 0) return res.status(400).json({ error: 'No paths provided' });
      
      const { target } = safePath(req.params.id, paths[0]);
      const parentDir = path.dirname(target);
      const baseNames = paths.map(p => path.basename(safePath(req.params.id, p).target));
      const archiveName = `archive_${Date.now()}.tar.gz`;
      const archivePath = path.join(parentDir, archiveName);
      
      execFile('tar', ['-czf', archivePath, '-C', parentDir, ...baseNames], (err) => {
        if (err) return res.status(500).json({ error: `Compression failed: ${err.message}` });
        res.json({ ok: true, archive: archiveName });
      });
      return;
    }

    if (!userPath) return res.status(400).json({ error: 'Path required.' });

    const { target } = safePath(req.params.id, userPath);
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

router.get('/servers/:id/playit/status', requirePermission('playit'), (req, res) => {
  try {
    const server = getDb().prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    const status = playitManager.getStatus(server.id, server.server_dir);
    res.json(status);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/servers/:id/playit/download', requirePermission('playit'), async (req, res) => {
  try {
    const server = getDb().prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    await playitManager.downloadPlayit(server.server_dir);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/servers/:id/playit/claim', requirePermission('playit'), (req, res) => {
  try {
    const server = getDb().prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    playitManager.setupClaim(server.id, server.server_dir);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/servers/:id/playit/secret', requirePermission('playit'), (req, res) => {
  try {
    const server = getDb().prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (!req.body.secret) return res.status(400).json({ error: 'Secret required' });
    playitManager.setupSecret(server.id, server.server_dir, req.body.secret);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/servers/:id/playit/reset', requirePermission('playit'), (req, res) => {
  try {
    const server = getDb().prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    playitManager.resetPlayit(server.id, server.server_dir);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PLAYERS MANAGEMENT ────────────────────────────────────────────────────────

router.get('/servers/:id/players', requirePermission('players'), async (req, res) => {
  const serverId = parseInt(req.params.id, 10);
  if (!pm.isRunning(serverId)) return res.json({ players: [] });
  const emitter = pm.getEmitter(serverId);
  if (!emitter) return res.json({ players: [] });

  return new Promise((resolve) => {
    let recentLines = [];
    let timeout = setTimeout(() => {
      emitter.off('line', onLine);
      const trace = recentLines.length > 0 ? recentLines.join(' | ') : 'No output received';
      resolve(res.status(400).json({ error: 'Timeout waiting for list command. Console trace: ' + trace }));
    }, 5000);

    let foundList = false;
    const onLine = (rawLine) => {
      if (process.env.DEBUG_CONSOLE_PARSE) {
        console.log('[DEBUG_CONSOLE_PARSE] RAW:', JSON.stringify(rawLine));
      }

      // Strip ANSI codes
      let line = rawLine.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
      // Strip console prefix
      line = line.replace(/^\[[^\]]*\]:?\s*(\[[^\]]*\]:?\s*)?/i, '').trim();

      recentLines.push(line);
      if (recentLines.length > 5) recentLines.shift();
      
      const summaryMatch = line.match(/there\s+are\s+(\d+)(?:\s*\/\s*|\s+of\s+a\s+max\s+of\s+)(\d+)\s+players?\s+online(?:[^:]*:)?\s*(.*)$/i);
      
      if (summaryMatch) {
        const count = parseInt(summaryMatch[1], 10);
        const playersStr = summaryMatch[3].trim();
        
        if (count === 0) {
          clearTimeout(timeout);
          emitter.off('line', onLine);
          return resolve(res.json({ players: [] }));
        }

        if (playersStr.length > 0) {
          const p = playersStr.split(',').map(x => x.trim().replace(/§[0-9a-fk-or]/ig, '')).filter(Boolean);
          clearTimeout(timeout);
          emitter.off('line', onLine);
          return resolve(res.json({ players: p }));
        }
        
        // No players on this line, but count > 0. Must be a multi-line output (e.g. Essentials).
        foundList = true;
        setTimeout(() => {
          if (foundList) {
            foundList = false;
            clearTimeout(timeout);
            emitter.off('line', onLine);
            resolve(res.json({ players: [] }));
          }
        }, 150);
      } else if (foundList) {
        foundList = false;
        let playerStr = line;
        if (line.includes(':')) {
           const parts = line.split(':');
           playerStr = parts[parts.length - 1];
        }
        const p = playerStr.split(',').map(x => x.trim().replace(/§[0-9a-fk-or]/ig, '')).filter(Boolean);
        clearTimeout(timeout);
        emitter.off('line', onLine);
        return resolve(res.json({ players: p }));
      }
    };
    emitter.on('line', onLine);
    pm.sendCommand(serverId, 'list');
  });
});

router.post('/servers/:id/players/command', requirePermission('players'), express.json(), (req, res) => {
  const { action, player } = req.body;
  const isAdmin = req.session.isAdmin;
  const perms = req.session.permissions || [];
  
  if (action === 'kick' && !isAdmin && !perms.includes('kick')) {
    return res.status(403).json({ error: 'Permission denied. Requires: kick' });
  }
  if ((action === 'ban' || action === 'unban') && !isAdmin && !perms.includes('ban')) {
    return res.status(403).json({ error: 'Permission denied. Requires: ban' });
  }
  let cmd = '';
  if (action === 'kick') cmd = `kick ${player}`;
  else if (action === 'ban') cmd = `ban ${player}`;
  else if (action === 'unban') cmd = `pardon ${player}`;
  else if (action === 'whitelist_add') cmd = `whitelist add ${player}`;
  else if (action === 'whitelist_remove') cmd = `whitelist remove ${player}`;
  else if (action === 'whitelist_on') cmd = `whitelist on`;
  else if (action === 'whitelist_off') cmd = `whitelist off`;
  
  const serverId = parseInt(req.params.id, 10);
  if (cmd) pm.sendCommand(serverId, cmd);

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

router.get('/servers/:id/players/lists', requirePermission('players'), (req, res) => {
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

router.post('/servers/:id/players/coordinates', requirePermission('players'), express.json(), async (req, res) => {
  if (!req.session.isAdmin && !req.session.permissions?.includes('coordinates')) {
    return res.status(403).json({ error: 'Permission denied. Requires: coordinates' });
  }
  const { player } = req.body;
  const serverId = parseInt(req.params.id, 10);
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
        const match = line.match(/entity data:\s*\[(.*?)\]/);
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
router.get('/servers/:id/settings', requirePermission('settings'), (req, res) => {
  const server = getDb().prepare('SELECT server_dir FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  let motd = 'A Minecraft Server';
  let onlineMode = true;
  let difficulty = 'easy';
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
      const difficultyMatch = props.match(/^difficulty=(peaceful|easy|normal|hard)$/m);
      if (difficultyMatch) difficulty = difficultyMatch[1];
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

  res.json({ motd, onlineMode, difficulty, antiXray, antiXrayEngine });
});

router.post('/servers/:id/settings/properties', requirePermission('settings'), express.json(), (req, res) => {
  const serverId = parseInt(req.params.id, 10);
  const server = getDb().prepare('SELECT server_dir FROM servers WHERE id = ?').get(serverId);
  if (!server) return res.status(404).json({ error: 'Not found' });
  
  const { motd, onlineMode, difficulty } = req.body;
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
      if (difficulty !== undefined) {
        if (/^difficulty=(peaceful|easy|normal|hard)$/m.test(props)) props = props.replace(/^difficulty=(peaceful|easy|normal|hard)$/m, `difficulty=${difficulty}`);
        else props += `\ndifficulty=${difficulty}\n`;
        
        // Apply instantly if server is running
        if (pm.isRunning(serverId)) {
          pm.sendCommand(serverId, `difficulty ${difficulty}`);
        }
      }
      fs.writeFileSync(propsPath, props);
    }
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/settings/antixray', requirePermission('settings'), express.json(), (req, res) => {
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

router.post('/servers/:id/settings/logo', requirePermission('settings'), express.json({limit: '5mb'}), (req, res) => {
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

router.post('/servers/:id/settings/ram', requirePermission('settings'), express.json(), (req, res) => {
  const serverId = parseInt(req.params.id, 10);
  const { ram } = req.body;
  if (!ram || ram < 512) return res.status(400).json({ error: 'RAM must be at least 512 MB.' });
  
  try {
    getDb().prepare('UPDATE servers SET memory_max = ?, memory_min = ? WHERE id = ?').run(ram, ram, serverId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/servers/:id/settings/version', requirePermission('settings'), express.json(), async (req, res) => {
  const server = getDb().prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  
  const { type, value } = req.body;
  if (!value) return res.status(400).json({ error: 'Version or URL is required' });
  
  try {
    let finalJar = '';
    if (type === 'url') {
      finalJar = path.join(server.server_dir, `custom-${Date.now()}.jar`);
      await downloadFile(value, finalJar);
    } else if (type === 'vanilla') {
      const vanilla = await fetchVanilla(value);
      finalJar = path.join(server.server_dir, vanilla.jarName);
      await downloadFile(vanilla.url, finalJar);
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
