'use strict';

// ── Sidebar (shared across all panel pages) ───────────────────────────────────
function toggleSidebar() {
  const sidebar  = document.getElementById('sidebar');
  const overlay  = document.getElementById('sidebarOverlay');
  const ham      = document.getElementById('hamburger');
  const isOpen   = sidebar?.classList.toggle('open');
  overlay?.classList.toggle('visible', isOpen);
  ham?.classList.toggle('open', isOpen);
}
function closeSidebar() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebarOverlay')?.classList.remove('visible');
  document.getElementById('hamburger')?.classList.remove('open');
}

// Close sidebar on ESC
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSidebar(); });
