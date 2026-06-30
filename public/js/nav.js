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
      const hasRentals = u.isAdmin ||
        u.permissions?.global?.includes('manage_rentals') ||
        (u.permissions?.servers && Object.keys(u.permissions.servers).length > 0);
      if (hasRentals) {
        const el = document.getElementById('navRentals');
        if (el) el.style.display = 'flex';
      }
    })
    .catch(() => {});
})();
