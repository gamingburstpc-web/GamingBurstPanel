'use strict';

const express  = require('express');
const path     = require('path');
const {
  verifyPassword, createSession, destroySession,
  requireAuth, cookieMiddleware,
  checkRateLimit, recordFailedAttempt, clearAttempts,
  hashPassword, updateUserSessions,
} = require('../auth');
const { getDb, hasUsers } = require('../db');

const router = express.Router();
router.use(cookieMiddleware);

// ── GET /login ────────────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  // If no users exist → show setup page
  if (!hasUsers()) {
    return res.sendFile(path.join(__dirname, '../../views/setup.html'));
  }
  res.sendFile(path.join(__dirname, '../../views/login.html'));
});

// ── POST /login ───────────────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  if (!hasUsers()) {
    return res.status(503).json({ error: 'No users configured. Run: node bin/gbpanel.js user add' });
  }

  if (checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  }

  const { username, password, rememberMe } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const user = getDb().prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  if (!user || !verifyPassword(password, user.password)) {
    recordFailedAttempt(ip);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  clearAttempts(ip);
  const sessionId = createSession(user);

  const cookieOptions = {
    httpOnly: true,
    sameSite: 'Strict'
  };
  
  if (rememberMe) {
    cookieOptions.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
  }
  
  res.cookie('session', sessionId, cookieOptions);

  if (user.must_change === 1) return res.json({ redirect: '/change-password' });
  return res.json({ redirect: '/dashboard' });
});

// ── GET /logout ───────────────────────────────────────────────────────────────
router.get('/logout', (req, res) => {
  const sessionId = req.cookies?.session;
  if (sessionId) destroySession(sessionId);
  res.clearCookie('session');
  res.redirect('/login');
});

// ── GET /change-password ─────────────────────────────────────────────────────
router.get('/change-password', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../../views/change-password.html'));
});

// ── POST /change-password ────────────────────────────────────────────────────
router.post('/change-password', requireAuth, (req, res) => {
  const { newPassword, confirmPassword } = req.body;
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters.' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }
  const hash = hashPassword(newPassword);
  getDb().prepare('UPDATE users SET password = ?, must_change = 0 WHERE id = ?')
    .run(hash, req.session.userId);
  // Update session data so mustChange is cleared without forcing re-login
  updateUserSessions(req.session.userId, { mustChange: false });
  res.json({ redirect: '/dashboard' });
});

// ── GET /api/setup-status (used by setup page to poll) ───────────────────────
router.get('/api/setup-status', (req, res) => {
  res.json({ hasUsers: hasUsers() });
});

// ── GET / → redirect ─────────────────────────────────────────────────────────
router.get('/', (req, res) => res.redirect('/dashboard'));

module.exports = router;
