'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getDb } = require('./db');

const BCRYPT_ROUNDS  = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── Session store: SQLite-backed with RAM fallback ────────────────────────────
// If SQLite sessions table isn't ready yet, falls back to RAM automatically.
// This prevents ANY database error from ever crashing the panel.
const ramSessions = new Map(); // fallback only

function dbSet(id, userId, data, expiresAt) {
  try {
    getDb().prepare('INSERT OR REPLACE INTO sessions (id, user_id, data, expires_at) VALUES (?, ?, ?, ?)')
      .run(id, userId, JSON.stringify(data), expiresAt);
    return true;
  } catch { return false; }
}

function dbGet(id) {
  try {
    return getDb().prepare('SELECT data, expires_at FROM sessions WHERE id = ?').get(id);
  } catch { return null; }
}

function dbDelete(id) {
  try { getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id); } catch {}
}

function dbDeleteUser(userId) {
  try { getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId); } catch {}
}

function dbGetByUser(userId) {
  try {
    return getDb().prepare('SELECT id, data FROM sessions WHERE user_id = ?').all(userId);
  } catch { return []; }
}

// Clean expired sessions every 30 minutes
setInterval(() => {
  try { getDb().prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()); } catch {}
  // Also clean RAM fallback
  const now = Date.now();
  for (const [k, v] of ramSessions) { if (v.expiresAt < now) ramSessions.delete(k); }
}, 30 * 60 * 1000).unref();


// ── Rate limiter (in-memory, resets on restart — that's fine) ─────────────────
const loginAttempts = new Map();
const MAX_ATTEMPTS  = 10;
const LOCKOUT_MS    = 15 * 60 * 1000;

function checkRateLimit(ip) {
  const now   = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(ip, { count: 0, resetAt: now + LOCKOUT_MS });
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailedAttempt(ip) {
  const now   = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, resetAt: now + LOCKOUT_MS };
  entry.count++;
  loginAttempts.set(ip, entry);
}

function clearAttempts(ip) { loginAttempts.delete(ip); }

setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of loginAttempts) {
    if (e.resetAt < now) loginAttempts.delete(ip);
  }
}, 30 * 60 * 1000).unref();

// ── Password helpers ──────────────────────────────────────────────────────────
function hashPassword(plain)         { return bcrypt.hashSync(plain, BCRYPT_ROUNDS); }
function verifyPassword(plain, hash) { return bcrypt.compareSync(plain, hash); }

// ── Session management ────────────────────────────────────────────────────────
function createSession(user) {
  const sessionId = crypto.randomUUID();
  let perms = { global: [], servers: {} };
  try {
    const p = JSON.parse(user.permissions || '[]');
    if (Array.isArray(p)) {
      perms.global = p;
    } else if (p && typeof p === 'object') {
      perms.global  = p.global  || [];
      perms.servers = p.servers || {};
    }
  } catch {}

  const data = {
    userId:      user.id,
    username:    user.username,
    isAdmin:     user.is_admin === 1,
    permissions: perms,
    mustChange:  user.must_change === 1,
  };

  const expiresAt = Date.now() + SESSION_TTL_MS;
  const saved = dbSet(sessionId, user.id, data, expiresAt);
  if (!saved) {
    // SQLite not ready yet — store in RAM as fallback
    ramSessions.set(sessionId, { ...data, expiresAt });
  }
  return sessionId;
}

function getSession(sessionId) {
  if (!sessionId) return null;
  // Check RAM fallback first
  const ram = ramSessions.get(sessionId);
  if (ram) {
    if (ram.expiresAt < Date.now()) { ramSessions.delete(sessionId); return null; }
    ram.expiresAt = Date.now() + SESSION_TTL_MS;
    return ram;
  }
  // Check SQLite
  const row = dbGet(sessionId);
  if (!row) return null;
  if (row.expires_at < Date.now()) { dbDelete(sessionId); return null; }
  // Slide the expiry window
  try { getDb().prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(Date.now() + SESSION_TTL_MS, sessionId); } catch {}
  try {
    const data = JSON.parse(row.data);
    ramSessions.set(sessionId, { ...data, expiresAt: Date.now() + SESSION_TTL_MS });
    return data;
  } catch { return null; }
}

function destroySession(sessionId) {
  ramSessions.delete(sessionId);
  dbDelete(sessionId);
}

function updateUserSessions(userId, updates) {
  // Update RAM sessions
  for (const [id, s] of ramSessions) {
    if (s.userId === userId) {
      if (updates.username    !== undefined) s.username    = updates.username;
      if (updates.isAdmin     !== undefined) s.isAdmin     = updates.isAdmin;
      if (updates.permissions !== undefined) s.permissions = updates.permissions;
      if (updates.mustChange  !== undefined) s.mustChange  = updates.mustChange;
    }
  }
  // Update SQLite sessions
  const rows = dbGetByUser(userId);
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data);
      if (updates.username    !== undefined) data.username    = updates.username;
      if (updates.isAdmin     !== undefined) data.isAdmin     = updates.isAdmin;
      if (updates.permissions !== undefined) data.permissions = updates.permissions;
      if (updates.mustChange  !== undefined) data.mustChange  = updates.mustChange;
      getDb().prepare('UPDATE sessions SET data = ? WHERE id = ?').run(JSON.stringify(data), row.id);
    } catch {}
  }
}

function destroyUserSessions(userId) {
  try { _db().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId); } catch {}
}

function parseSessionFromCookieHeader(cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/session=([^;]+)/);
  return match ? match[1] : null;
}

// ── Zero-dep cookie parser ────────────────────────────────────────────────────
function cookieMiddleware(req, res, next) {
  req.cookies = {};
  const header = req.headers.cookie || '';
  header.split(';').forEach(pair => {
    const [k, ...v] = pair.trim().split('=');
    if (k) req.cookies[k.trim()] = decodeURIComponent(v.join('=').trim());
  });
  next();
}

function parseCookieFromReq(req) {
  const h = req.headers.cookie || '';
  const m = h.match(/session=([^;]+)/);
  return m ? m[1] : null;
}

// ── Middleware: require any authenticated user ────────────────────────────────
function requireAuth(req, res, next) {
  const sessionId = req.cookies?.session || parseCookieFromReq(req);
  const sess      = getSession(sessionId);
  if (!sess) {
    if (req.originalUrl.includes('/api') || req.headers.accept?.includes('application/json')) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    return res.redirect('/login');
  }
  req.session   = sess;
  req.sessionId = sessionId;
  next();
}

// ── Middleware: require admin role ────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!req.session?.isAdmin) {
    if (req.originalUrl.includes('/api') || req.headers.accept?.includes('application/json')) {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    return res.redirect('/dashboard?error=forbidden');
  }
  next();
}

// ── Middleware: require specific permission ───────────────────────────────────
function requirePermission(perm) {
  return (req, res, next) => {
    if (req.session?.isAdmin) return next();
    const p = req.session?.permissions || { global: [], servers: {} };

    if (Array.isArray(p)) {
      if (p.includes(perm)) return next();
    } else {
      if (p.global?.includes(perm)) return next();
      const serverId = req.params.id ? String(parseInt(req.params.id, 10)) : null;
      if (serverId && p.servers && p.servers[serverId]?.includes(perm)) return next();
    }

    if (req.originalUrl.includes('/api') || req.headers.accept?.includes('application/json')) {
      return res.status(403).json({ error: `Permission denied: ${perm}` });
    }
    return res.redirect('/dashboard?error=forbidden');
  };
}

// ── Middleware: require any of the specified permissions ──────────────────────
function requireAnyPermission(permsList) {
  return (req, res, next) => {
    if (req.session?.isAdmin) return next();
    const p = req.session?.permissions || { global: [], servers: {} };

    let hasOne = false;
    for (const perm of permsList) {
      if (Array.isArray(p)) {
        if (p.includes(perm)) { hasOne = true; break; }
      } else {
        if (p.global?.includes(perm)) { hasOne = true; break; }
        const serverId = req.params.id ? String(parseInt(req.params.id, 10)) : null;
        if (serverId && p.servers && p.servers[serverId]?.includes(perm)) { hasOne = true; break; }
      }
    }

    if (hasOne) return next();

    if (req.originalUrl.includes('/api') || req.headers.accept?.includes('application/json')) {
      return res.status(403).json({ error: `Permission denied. Requires one of: ${permsList.join(', ')}` });
    }
    return res.redirect('/dashboard?error=forbidden');
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  getSession,
  destroySession,
  updateUserSessions,
  destroyUserSessions,
  requireAuth,
  requireAdmin,
  requirePermission,
  requireAnyPermission,
  cookieMiddleware,
  parseSessionFromCookieHeader,
  checkRateLimit,
  recordFailedAttempt,
  clearAttempts,
};
