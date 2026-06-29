'use strict';

const express  = require('express');
const path     = require('path');
const { requireAuth, requireAdmin, cookieMiddleware } = require('../auth');

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
  res.sendFile(path.join(__dirname, '../../views/dashboard.html'));
});

// ── GET /servers/new — admin only ─────────────────────────────────────────────
router.get('/servers/new', requireAuth, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '../../views/create-server.html'));
});

// ── GET /users — admin only ───────────────────────────────────────────────────
router.get('/users', requireAuth, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '../../views/users.html'));
});

// ── Rentals (Assigned Servers) ────────────────────────────────────────────────
router.get('/rentals', requireAuth, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '../../views/rentals.html'));
});

// ── GET /servers/:id ──────────────────────────────────────────────────────────
router.get('/servers/:id', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../../views/server-detail.html'));
});

module.exports = router;
