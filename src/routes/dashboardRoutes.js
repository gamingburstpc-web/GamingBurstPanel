'use strict';

const express  = require('express');
const path     = require('path');
const { requireAuth, requireAdmin, requireAnyPermission, cookieMiddleware } = require('../auth');

const router = express.Router();
router.use(cookieMiddleware);

// Prevent caching for all dashboard HTML pages
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// ── GET /dashboard ────────────────────────────────────────────────────────────
router.get('/dashboard', requireAuth, (req, res) => {
  // If user has NO global permissions and NO admin flag, but HAS server-specific permissions,
  // they are a "server-assigned user" — redirect them straight to their server.
  if (!req.session.isAdmin) {
    const p = req.session.permissions || { global: [], servers: {} };
    const perms = Array.isArray(p) ? { global: p, servers: {} } : p;
    const hasGlobal = perms.global && perms.global.length > 0;
    const serverIds = perms.servers
      ? Object.keys(perms.servers).filter(sid => perms.servers[sid] && perms.servers[sid].length > 0)
      : [];

    if (!hasGlobal && serverIds.length > 0) {
      return res.redirect(`/servers/${serverIds[0]}`);
    }
  }
  res.sendFile(path.join(__dirname, '../../views/dashboard.html'));
});

// ── GET /servers/new — admin only ─────────────────────────────────────────────
router.get('/servers/new', requireAuth, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '../../views/create-server.html'));
});

// ── GET /users — admin only ───────────────────────────────────────────────────
router.get('/users', requireAuth, requireAnyPermission(['create_users', 'delete_users']), (req, res) => {
  res.sendFile(path.join(__dirname, '../../views/users.html'));
});

// ── Rentals (Assigned Servers) ────────────────────────────────────────────────
router.get('/rentals', requireAuth, requireAnyPermission(['manage_rentals']), (req, res) => {
  res.sendFile(path.join(__dirname, '../../views/rentals.html'));
});

// ── GET /servers/:id ──────────────────────────────────────────────────────────
router.get('/servers/:id', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../../views/server-detail.html'));
});

module.exports = router;
