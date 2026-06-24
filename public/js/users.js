'use strict';

let myId = null;

async function fetchMe() {
  try {
    const r = await fetch('/api/me');
    const d = await r.json();
    myId = d.id;
  } catch {}
}

async function loadUsers() {
  const tbody = document.getElementById('usersList');
  try {
    const res = await fetch('/api/users');
    if (!res.ok) throw new Error('Failed to fetch users');
    const users = await res.json();
    
    if (users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:32px;color:var(--text-muted)">No users found.</td></tr>';
      return;
    }

    let html = '';
    for (const u of users) {
      const isMe = u.id === myId;
      const roleBadge = u.is_admin === 1 
        ? `<span class="badge" style="background:rgba(91,110,255,0.1);color:var(--accent)">Admin</span>`
        : `<span class="badge" style="background:rgba(255,255,255,0.05);color:var(--text-secondary)">User</span>`;
      
      const permsInfo = u.is_admin === 1 
        ? '<span class="text-muted text-sm">All Permissions</span>'
        : `<span class="text-muted text-sm">${u.permissions.join(', ') || 'No extra perms'}</span>`;

      html += `
        <tr>
          <td>#${u.id}</td>
          <td><strong style="color:var(--text-primary)">${u.username}</strong> ${isMe ? '<span style="font-size:11px;color:var(--text-muted)">(You)</span>' : ''}</td>
          <td>${roleBadge}<br>${permsInfo}</td>
          <td class="text-muted text-sm">${new Date(u.created_at).toLocaleDateString()}</td>
          <td style="text-align:right">
            ${!isMe ? `<button class="btn btn-sm" style="background:rgba(248,81,73,0.1);color:#f85149;border-color:transparent;" onclick="deleteUser(${u.id}, '${u.username}')">Delete</button>` : ''}
          </td>
        </tr>
      `;
    }
    tbody.innerHTML = html;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:32px;color:#f85149">Error: ${err.message}</td></tr>`;
  }
}

function togglePerms() {
  const isAdmin = document.getElementById('addIsAdmin').checked;
  const permsGroup = document.getElementById('permsGroup');
  const checkboxes = document.querySelectorAll('.perm-cb');
  
  if (isAdmin) {
    permsGroup.style.opacity = '0.5';
    checkboxes.forEach(cb => cb.disabled = true);
  } else {
    permsGroup.style.opacity = '1';
    checkboxes.forEach(cb => cb.disabled = false);
  }
}

document.getElementById('addUserForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('addBtn');
  const alertE = document.getElementById('alert');
  const alertS = document.getElementById('alertSuccess');
  alertE.classList.add('hidden');
  alertS.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Creating...';

  const username = document.getElementById('addUsername').value;
  const password = document.getElementById('addPassword').value;
  const is_admin = document.getElementById('addIsAdmin').checked;
  const permissions = Array.from(document.querySelectorAll('.perm-cb:checked')).map(cb => cb.value);

  try {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, is_admin, permissions })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to create user');
    
    document.getElementById('addUsername').value = '';
    document.getElementById('addPassword').value = '';
    document.querySelectorAll('.perm-cb').forEach(cb => cb.checked = false);
    
    alertS.querySelector('#alertSuccessMsg').textContent = `User ${username} created!`;
    alertS.classList.remove('hidden');
    loadUsers();
  } catch (err) {
    alertE.querySelector('#alertMsg').textContent = err.message;
    alertE.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create User';
  }
});

async function deleteUser(id, username) {
  if (!confirm(`Are you sure you want to delete user "${username}"?`)) return;
  try {
    const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to delete');
    loadUsers();
  } catch (err) {
    alert(err.message);
  }
}

// Init
(async () => {
  await fetchMe();
  loadUsers();
})();
