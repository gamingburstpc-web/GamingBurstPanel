'use strict';
// ── nav.js: Runs on every page to hide admin-only nav items for non-admins ────
// Admin items are visible by default in HTML (so admins never see a broken nav).
// This script hides them ONLY after confirming the user is not an admin.
(function () {
  fetch('/api/me')
    .then(r => r.ok ? r.json() : null)
    .then(u => {
      if (!u) return;
      if (!u.isAdmin) {
        ['navNewServer', 'navUsers'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.style.display = 'none';
        });
      }
      if (u.isAdmin) {
        const btn = document.getElementById('navUpdatePanel');
        if (btn) btn.style.display = 'flex';
      }
      // Hide Assigned Servers for users who have no server permissions
      const hasRentals = u.isAdmin ||
        u.permissions?.global?.includes('manage_rentals') ||
        (u.permissions?.servers && Object.keys(u.permissions.servers).length > 0);
      if (!hasRentals) {
        const el = document.getElementById('navRentals');
        if (el) el.style.display = 'none';
      }
    })
    .catch(() => {});
})();
