'use strict';
// ── nav.js: Runs on every page to hide admin-only nav items for non-admins ────
// Admin items are visible by default in HTML (so admins never see a broken nav).
// This script hides them ONLY after confirming the user is not an admin.
(function () {
  fetch('/api/me')
    .then(r => r.ok ? r.json() : null)
    .then(u => {
      if (!u) return;
      if (u.isAdmin) {
        ['navNewServer', 'navUsers', 'navUpdatePanel'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.style.display = 'flex';
        });
      }
      const p = u.permissions || {};
      const hasRentals = u.isAdmin ||
        (Array.isArray(p) ? p.includes('manage_rentals') : p.global?.includes('manage_rentals'));
      if (hasRentals) {
        const el = document.getElementById('navRentals');
        if (el) el.style.display = 'flex';
      }
    })
    .catch(() => {});
})();
