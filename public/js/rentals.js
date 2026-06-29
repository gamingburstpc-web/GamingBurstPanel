let servers = [];
let users = [];
let editServerId = null;

async function fetchInitialData() {
  try {
    const [meRes, sRes, uRes] = await Promise.all([
      fetch('/api/me'),
      fetch('/api/servers'),
      fetch('/api/users')
    ]);
    const me = await meRes.json();
    if (me.username) {
      document.getElementById('sidebarUsername').textContent = me.username;
      document.getElementById('avatarInitial').textContent = me.username[0].toUpperCase();
    }
    
    servers = await sRes.json();
    users = await uRes.json();
    
    // Populate User Dropdowns
    const userSelect = document.getElementById('userSelect');
    const subUserSelect = document.getElementById('subUserSelect');
    userSelect.innerHTML = '<option value="">-- No User (Unassigned) --</option>';
    if (subUserSelect) subUserSelect.innerHTML = '<option value="">-- Select a User --</option>';
    
    users.forEach(u => {
      if (!u.is_admin) {
        userSelect.innerHTML += `<option value="${u.id}">${u.username}</option>`;
        if (subUserSelect) subUserSelect.innerHTML += `<option value="${u.id}">${u.username}</option>`;
      }
    });

    renderServers();
  } catch (e) {
    console.error(e);
  }
}

function renderServers() {
  const tbody = document.getElementById('serversList');
  tbody.innerHTML = '';
  
  if (servers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px;">No servers found.</td></tr>';
    return;
  }
  
  servers.forEach(s => {
    let ownerText = '<span style="color:var(--text-muted)">Unassigned</span>';
    if (s.owner_id) {
      const u = users.find(x => x.id === s.owner_id);
      ownerText = u ? `<b>${u.username}</b>` : `<i>Unknown (${s.owner_id})</i>`;
    }
    
    let expText = '<span style="color:var(--text-muted)">Permanent</span>';
    let isExpired = false;
    if (s.expire_at) {
      const diff = s.expire_at - Date.now();
      if (diff <= 0) {
        isExpired = true;
        expText = '<span class="expired-badge">Expired</span>';
      } else {
        const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
        expText = `<span style="color:var(--green)">${days} days left</span>`;
      }
    }
    
    const tr = document.createElement('tr');
    if (isExpired) tr.classList.add('expired-row');
    
    tr.innerHTML = `
      <td>#${s.id}</td>
      <td>${s.name}</td>
      <td>${ownerText}</td>
      <td>${expText}</td>
      <td style="text-align:right">
        <button class="btn btn-sm" onclick="openManageForm(${s.id})">Manage Assignment</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function openManageForm(id) {
  editServerId = id;
  const s = servers.find(x => x.id === id);
  if (!s) return;
  
  document.getElementById('formCardTitle').textContent = `Manage Server #${id} (${s.name})`;
  document.getElementById('editServerId').value = id;
  document.getElementById('formCard').style.display = 'block';
  
  document.getElementById('alertSuccess').classList.add('hidden');
  document.getElementById('alertError').classList.add('hidden');
  
  const valLabel = document.getElementById('validityLabel');
  const endSubBtn = document.getElementById('endSubBtn');
  
  if (s.owner_id) {
    const owner = users.find(x => x.id === s.owner_id);
    document.getElementById('formCardTitle').textContent = `Server Assigned to: ${owner ? owner.username : 'Unknown'} (${s.name})`;
    valLabel.textContent = 'Extend Validity';
    if (s.expire_at) {
      endSubBtn.style.display = 'block';
    } else {
      endSubBtn.style.display = 'none';
    }
  } else {
    document.getElementById('formCardTitle').textContent = `New Assignment (${s.name})`;
    valLabel.textContent = 'Set Validity';
    endSubBtn.style.display = 'none';
  }
  
  // Set User
  document.getElementById('userSelect').value = s.owner_id || '';
  
  // Set expiration text
  const expText = document.getElementById('currentExpirationText');
  if (s.expire_at) {
    const d = new Date(s.expire_at);
    expText.textContent = `Currently expires on: ${d.toLocaleString()}`;
  } else {
    expText.textContent = 'Currently permanent (no expiration).';
  }
  document.getElementById('validitySelect').value = 'none'; // reset to none
  
  // Set deletion text
  const delText = document.getElementById('currentDeletionText');
  if (s.delete_after) {
    if (s.expire_at) {
      const d = new Date(s.expire_at + (s.delete_after * 24 * 60 * 60 * 1000));
      delText.textContent = `Will automatically delete on: ${d.toLocaleString()}`;
    } else {
      delText.textContent = `Currently set to delete ${s.delete_after} days after expiration.`;
    }
  } else {
    delText.textContent = `Currently won't delete automatically.`;
  }
  document.getElementById('deleteSelect').value = 'none'; // reset
  
  // Set Permissions
  document.querySelectorAll('.s-perm-cb').forEach(cb => cb.checked = false);
  if (s.owner_id) {
    const u = users.find(x => x.id === s.owner_id);
    if (u && u.permissions && u.permissions.servers && u.permissions.servers[id]) {
      const sPerms = u.permissions.servers[id];
      document.querySelectorAll('.s-perm-cb').forEach(cb => {
        if (sPerms.includes(cb.value)) cb.checked = true;
      });
    }
  } else {
    // Default perms for new assignment
    const defaults = ['start', 'stop', 'restart', 'console', 'files', 'settings', 'players', 'kick', 'ban', 'coordinates', 'delete'];
    document.querySelectorAll('.s-perm-cb').forEach(cb => {
      if (defaults.includes(cb.value)) cb.checked = true;
    });
  }
  
  // Load Sub-Users
  document.getElementById('subUsersContainer').innerHTML = '';
  users.forEach(u => {
    if (u.id !== s.owner_id && u.permissions && u.permissions.servers && u.permissions.servers[id]) {
      addSubUserBlock(u.id, u.permissions.servers[id]);
    }
  });
}

function addSubUserBlock(existingUserId = null, existingPerms = []) {
  const container = document.getElementById('subUsersContainer');
  let userIdStr = existingUserId;
  
  if (!userIdStr) {
    const sel = document.getElementById('subUserSelect');
    if (!sel.value) return;
    userIdStr = sel.value;
    sel.value = '';
  }
  
  // Check if block already exists
  if (document.getElementById(`subUserBlock_${userIdStr}`)) return;
  
  const user = users.find(u => u.id == userIdStr);
  const username = user ? user.username : `User #${userIdStr}`;
  
  const div = document.createElement('div');
  div.className = 'sub-user-block';
  div.id = `subUserBlock_${userIdStr}`;
  div.dataset.userId = userIdStr;
  div.style.background = 'rgba(255,255,255,0.02)';
  div.style.padding = '12px';
  div.style.borderRadius = '8px';
  div.style.marginBottom = '12px';
  div.style.border = '1px solid var(--border-color)';
  
  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.justifyContent = 'space-between';
  header.style.alignItems = 'center';
  header.style.marginBottom = '8px';
  header.innerHTML = `<strong style="font-size:14px;">${username}</strong>
    <button type="button" class="btn btn-sm btn-ghost" style="color:var(--red);" onclick="this.parentElement.parentElement.remove()">Remove</button>`;
  
  const grid = document.createElement('div');
  grid.className = 'perm-grid';
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(130px, 1fr))';
  grid.style.gap = '12px';
  
  const perms = ['start', 'stop', 'restart', 'console', 'files', 'settings', 'players', 'kick', 'ban', 'coordinates', 'delete'];
  perms.forEach(p => {
    const lbl = document.createElement('label');
    lbl.style.display = 'flex';
    lbl.style.alignItems = 'center';
    lbl.style.gap = '8px';
    lbl.style.fontSize = '14px';
    const checked = existingPerms.includes(p) ? 'checked' : '';
    lbl.innerHTML = `<input type="checkbox" class="sub-perm-cb" value="${p}" ${checked}> ${p.charAt(0).toUpperCase() + p.slice(1)}`;
    grid.appendChild(lbl);
  });
  
  div.appendChild(header);
  div.appendChild(grid);
  container.appendChild(div);
}

function closeForm() {
  document.getElementById('formCard').style.display = 'none';
  editServerId = null;
}

async function endSubscription() {
  const serverId = document.getElementById('editServerId').value;
  if (!serverId) return;
  if (!confirm("Are you sure you want to end this subscription immediately? The user will be locked out and the auto-deletion countdown will begin.")) return;
  
  try {
    const res = await fetch(`/api/rentals/${serverId}/end`, { method: 'POST' });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to end subscription');
    }
    document.getElementById('alertSuccess').textContent = 'Subscription ended successfully!';
    document.getElementById('alertSuccess').classList.remove('hidden');
    await fetchInitialData();
    closeForm();
  } catch (err) {
    document.getElementById('alertError').textContent = err.message;
    document.getElementById('alertError').classList.remove('hidden');
  }
}

document.getElementById('assignmentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('saveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';
  document.getElementById('alertSuccess').classList.add('hidden');
  document.getElementById('alertError').classList.add('hidden');
  
  const serverId = document.getElementById('editServerId').value;
  const userId = document.getElementById('userSelect').value; // could be empty string
  const validityStr = document.getElementById('validitySelect').value;
  const deleteStr = document.getElementById('deleteSelect').value;
  
  const server = servers.find(s => s.id == serverId);
  
  let expire_at = undefined;
  if (validityStr === 'permanent') {
    expire_at = null;
  } else if (validityStr !== 'none') {
    const days = parseInt(validityStr, 10);
    expire_at = Date.now() + (days * 24 * 60 * 60 * 1000);
  }
  
  let targetExpireAt = expire_at !== undefined ? expire_at : (server ? server.expire_at : null);
  
  let delete_after = undefined;
  if (deleteStr === 'never') {
    delete_after = null;
  } else if (deleteStr !== 'none') {
    delete_after = parseInt(deleteStr, 10);
  }
  
  const perms = [];
  document.querySelectorAll('.s-perm-cb').forEach(cb => {
    if (cb.checked) perms.push(cb.value);
  });
  
  const subUsers = {};
  document.querySelectorAll('.sub-user-block').forEach(blk => {
    const uId = blk.dataset.userId;
    const uPerms = [];
    blk.querySelectorAll('.sub-perm-cb:checked').forEach(cb => uPerms.push(cb.value));
    subUsers[uId] = uPerms;
  });
  
  try {
    const res = await fetch(`/api/rentals/${serverId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner_id: userId || null, expire_at, delete_after, perms, subUsers })
    });
    
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to update assignment');
    }
    
    document.getElementById('alertSuccess').classList.remove('hidden');
    // Reload data
    await fetchInitialData();
    // Update form if still open
    if (editServerId) openManageForm(editServerId);
  } catch (err) {
    document.getElementById('alertError').textContent = err.message;
    document.getElementById('alertError').classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Assignment';
  }
});

fetchInitialData();
