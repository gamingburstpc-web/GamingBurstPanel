'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getDb } = require('./db');

const BCRYPT_ROUNDS  = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — persistent across restarts

// ── Session store: SQLite-backed (survives panel restarts) ─────────────────────
function _db() { return getDb(); }

// Clean expired sessions every 30 minutes
setInterval(() => {
  try { _db().prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()); } catch {}
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
  _db().prepare('INSERT OR REPLACE INTO sessions (id, user_id, data, expires_at) VALUES (?, ?, ?, ?)')
    .run(sessionId, user.id, JSON.stringify(data), expiresAt);

  return sessionId;
}

function getSession(sessionId) {
  if (!sessionId) return null;
  try {
    const row = _db().prepare('SELECT data, expires_at FROM sessions WHERE id = ?').get(sessionId);
    if (!row) return null;
    if (row.expires_at < Date.now()) {
      _db().prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
      return null;
    }
    // Slide the window: extend expiry on every access
    _db().prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
      .run(Date.now() + SESSION_TTL_MS, sessionId);
    return JSON.parse(row.data);
  } catch { return null; }
}

function destroySession(sessionId) {
  try { _db().prepare('DELETE FROM sessions WHERE id = ?').run(sessionId); } catch {}
}

function updateUserSessions(userId, updates) {
  try {
    const rows = _db().prepare('SELECT id, data FROM sessions WHERE user_id = ?').all(userId);
    for (const row of rows) {
      try {
        const data = JSON.parse(row.data);
        if (updates.username    !== undefined) data.username    = updates.username;
        if (updates.isAdmin     !== undefined) data.isAdmin     = updates.isAdmin;
        if (updates.permissions !== undefined) data.permissions = updates.permissions;
        if (updates.mustChange  !== undefined) data.mustChange  = updates.mustChange;
        _db().prepare('UPDATE sessions SET data = ? WHERE id = ?').run(JSON.stringify(data), row.id);
      } catch {}
    }
  } catch {}
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
  checkRateLimit,
  recordFailedAttempt,
  clearAttempts,
};
