// Shell behaviour that belongs to the static HTML rather than to any page:
//   public shell  — fills #last-sync in the footer from GET /api/meta
//   admin shell   — wires the "Sign out" button (#admin-logout) in #admin-nav
// Loaded by index.html and admin.html. Fails silently: the pages work without it.

import { api } from './api.js';
import { fmt } from './ui.js';

const lastSync = document.getElementById('last-sync');
if (lastSync) {
  const paused = document.getElementById('sync-paused');
  const show = (meta) => {
    if (!meta) return;
    if (meta.lastSyncAt) {
      lastSync.textContent = `Data updated ${fmt.rel(meta.lastSyncAt)}.${meta.updatesPaused && !paused ? ' Updates are paused.' : ''}`;
      lastSync.title = `Last successful fetch from GitHub: ${fmt.datetime(meta.lastSyncAt)}`;
      lastSync.hidden = false;
    }
    if (paused) {
      paused.textContent = meta.updatesPaused ? 'Updates are paused.' : '';
      paused.hidden = !meta.updatesPaused;
    }
  };
  const load = () => api.get('/meta').then(show).catch(() => {});
  load();
  // keep "updated … ago" honest on a tab left open
  setInterval(() => { if (!document.hidden) load(); }, 5 * 60 * 1000);
}

const logout = document.getElementById('admin-logout');
if (logout) {
  logout.addEventListener('click', async () => {
    logout.disabled = true;
    try { await api.post('/admin/logout'); } catch { /* the cookie may already be gone */ }
    location.hash = '#/';
    location.reload();
  });
}
