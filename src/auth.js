'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { stmt, getDb } = require('./db');

const BCRYPT_ROUNDS  = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Session store ─────────────────────────────────────────────────────────────
const sessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.expiresAt < now) sessions.delete(id);
  }
}, 30 * 60 * 1000).unref();

// ── Rate limiter ──────────────────────────────────────────────────────────────
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
function hashPassword(plain)       { return bcrypt.hashSync(plain, BCRYPT_ROUNDS); }
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
      perms.global = p.global || [];
      perms.servers = p.servers || {};
    }
  } catch {}

  sessions.set(sessionId, {
    userId:     user.id,
    username:   user.username,
    isAdmin:    user.is_admin === 1,
    permissions: perms,
    mustChange: user.must_change === 1,
    expiresAt:  Date.now() + SESSION_TTL_MS,
  });
  return sessionId;
}

function getSession(sessionId) {
  if (!sessionId) return null;
  const sess = sessions.get(sessionId);
  if (!sess) return null;
  if (sess.expiresAt < Date.now()) { sessions.delete(sessionId); return null; }
  sess.expiresAt = Date.now() + SESSION_TTL_MS; // sliding window
  return sess;
}

function destroySession(sessionId) { sessions.delete(sessionId); }

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
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthenticated' });
    return res.redirect('/login');
  }
  req.session   = sess;
  req.sessionId = sessionId;
  next();
}

// ── Middleware: require admin role ────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!req.session?.isAdmin) {
    if (req.path.startsWith('/api/') || req.headers.accept?.includes('application/json')) {
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
      const serverId = req.params.id || req.body.serverId || req.query.serverId;
      if (serverId && p.servers && p.servers[serverId]?.includes(perm)) return next();
    }
    
    if (req.path.startsWith('/api/') || req.headers.accept?.includes('application/json')) {
      return res.status(403).json({ error: `Permission denied. Requires: ${perm}` });
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
        const serverId = req.params.id || req.body.serverId || req.query.serverId;
        if (serverId && p.servers && p.servers[serverId]?.includes(perm)) { hasOne = true; break; }
      }
    }
    
    if (hasOne) return next();
    
    if (req.path.startsWith('/api/') || req.headers.accept?.includes('application/json')) {
      return res.status(403).json({ error: `Permission denied. Requires one of: ${permsList.join(', ')}` });
    }
    return res.redirect('/dashboard?error=forbidden');
  };
}

function updateUserSessions(userId, updates) {
  for (const [id, s] of sessions) {
    if (s.userId === userId) {
      if (updates.username !== undefined) s.username = updates.username;
      if (updates.isAdmin !== undefined) s.isAdmin = updates.isAdmin;
      if (updates.permissions !== undefined) s.permissions = updates.permissions;
      if (updates.mustChange !== undefined) s.mustChange = updates.mustChange;
    }
  }
}

function destroyUserSessions(userId) {
  for (const [id, s] of sessions) {
    if (s.userId === userId) {
      sessions.delete(id);
    }
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  getSession,
  destroySession,
  parseSessionFromCookieHeader,
  requireAuth,
  requireAdmin,
  requirePermission,
  requireAnyPermission,
  cookieMiddleware,
  checkRateLimit,
  recordFailedAttempt,
  clearAttempts,
  updateUserSessions,
  destroyUserSessions,
};
