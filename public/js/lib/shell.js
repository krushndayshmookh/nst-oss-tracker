// Shell behaviour that belongs to the static HTML rather than to any page:
//   public shell  — fills #last-sync in the footer from GET /api/meta
//   admin shell   — wires the "Sign out" button (#admin-logout) in #admin-nav
// Loaded by index.html and admin.html. Fails silently: the pages work without it.

import { api } from './api.js';
import { fmt } from './ui.js';

const lastSync = document.getElementById('last-sync');
if (lastSync) {
  api.get('/meta').then((meta) => {
    if (!meta || !meta.lastSyncAt) return;
    lastSync.textContent = `Data updated ${fmt.rel(meta.lastSyncAt)}.`;
    lastSync.title = fmt.datetime(meta.lastSyncAt);
    lastSync.hidden = false;
  }).catch(() => {});
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
