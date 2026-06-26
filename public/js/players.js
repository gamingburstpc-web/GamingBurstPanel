// players.js

let isWhitelistEnabled = false;

async function loadOnlinePlayers() {
  const listEl = document.getElementById('onlinePlayersList');
  if (!listEl) return;
  
  if (serverData?.status !== 'running') {
    listEl.innerHTML = '<div class="text-muted text-center py-4">Server is offline.</div>';
    return;
  }
  
  listEl.innerHTML = '<div class="text-muted text-center py-4">Loading players...</div>';
  
  try {
    const res = await fetch(`/api/servers/${serverId}/players`);
    const data = await res.json();
    
    if (!data.players || data.players.length === 0) {
      listEl.innerHTML = '<div class="text-muted text-center py-4">No players online.</div>';
      return;
    }
    
    listEl.innerHTML = '';
    data.players.forEach(player => {
      const div = document.createElement('div');
      div.style.display = 'flex';
      div.style.justifyContent = 'space-between';
      div.style.alignItems = 'center';
      div.style.background = 'rgba(255,255,255,0.05)';
      div.style.padding = '8px 12px';
      div.style.borderRadius = '6px';
      
      const leftDiv = document.createElement('div');
      leftDiv.style.display = 'flex';
      leftDiv.style.alignItems = 'center';
      leftDiv.style.gap = '12px';
      
      const avatar = document.createElement('img');
      avatar.src = `https://minotar.net/helm/${player}/32.png`;
      avatar.style.width = '32px';
      avatar.style.height = '32px';
      avatar.style.borderRadius = '4px';
      avatar.onerror = () => { avatar.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="%23333"/></svg>' };
      
      const name = document.createElement('span');
      name.textContent = player;
      name.style.fontWeight = '600';
      
      const coordsBtn = document.createElement('button');
      coordsBtn.className = 'btn btn-ghost btn-sm';
      coordsBtn.title = 'Get Coordinates';
      coordsBtn.innerHTML = '👁';
      const coordsText = document.createElement('span');
      coordsText.className = 'text-muted text-sm';
      coordsText.style.marginLeft = '8px';
      
      coordsBtn.onclick = async () => {
        coordsText.textContent = 'Fetching...';
        try {
          const cRes = await fetch(`/api/servers/${serverId}/players/coordinates`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ player })
          });
          const cData = await cRes.json();
          if (cData.coordinates) coordsText.textContent = cData.coordinates;
          else coordsText.textContent = cData.error || 'Failed';
        } catch {
          coordsText.textContent = 'Error';
        }
      };
      
      leftDiv.appendChild(avatar);
      leftDiv.appendChild(name);
      leftDiv.appendChild(coordsBtn);
      leftDiv.appendChild(coordsText);
      
      const rightDiv = document.createElement('div');
      rightDiv.style.display = 'flex';
      rightDiv.style.gap = '8px';
      
      const btnKick = document.createElement('button');
      btnKick.className = 'btn btn-secondary btn-sm';
      btnKick.textContent = 'Kick';
      btnKick.onclick = () => sendPlayerCommand('kick', player);
      
      const btnBan = document.createElement('button');
      btnBan.className = 'btn btn-danger btn-sm';
      btnBan.textContent = 'Ban';
      btnBan.onclick = () => {
        if (confirm(`Are you sure you want to ban ${player}?`)) sendPlayerCommand('ban', player);
      };
      
      rightDiv.appendChild(btnKick);
      rightDiv.appendChild(btnBan);
      
      div.appendChild(leftDiv);
      div.appendChild(rightDiv);
      listEl.appendChild(div);
    });
  } catch (e) {
    listEl.innerHTML = '<div class="text-danger text-center py-4">Failed to fetch players.</div>';
  }
}

async function loadPlayerLists() {
  try {
    const res = await fetch(`/api/servers/${serverId}/players/lists`);
    const data = await res.json();
    
    // Update Whitelist Badge
    isWhitelistEnabled = data.whitelistEnabled;
    const badge = document.getElementById('whitelistStatusBadge');
    if (badge) {
      if (isWhitelistEnabled) {
        badge.className = 'badge badge-running';
        badge.textContent = 'Enabled';
      } else {
        badge.className = 'badge badge-stopped';
        badge.textContent = 'Disabled';
      }
    }
    
    // Whitelist List
    const wList = document.getElementById('whitelistList');
    if (wList) {
      wList.innerHTML = '';
      if (!data.whitelist || data.whitelist.length === 0) {
        wList.innerHTML = '<div class="text-muted text-sm">No whitelisted players.</div>';
      } else {
        data.whitelist.forEach(item => {
          const div = document.createElement('div');
          div.style.display = 'flex';
          div.style.justifyContent = 'space-between';
          div.style.alignItems = 'center';
          div.style.padding = '6px 12px';
          div.style.background = 'rgba(255,255,255,0.02)';
          div.style.borderRadius = '4px';
          
          const name = document.createElement('span');
          name.textContent = item.name;
          
          const rmBtn = document.createElement('button');
          rmBtn.className = 'btn btn-ghost btn-sm text-danger';
          rmBtn.textContent = 'Remove';
          rmBtn.onclick = () => sendPlayerCommand('whitelist_remove', item.name);
          
          div.appendChild(name);
          div.appendChild(rmBtn);
          wList.appendChild(div);
        });
      }
    }
    
    // Banned List
    const bList = document.getElementById('bannedPlayersList');
    if (bList) {
      bList.innerHTML = '';
      if (!data.banned || data.banned.length === 0) {
        bList.innerHTML = '<div class="text-muted text-sm">No banned players.</div>';
      } else {
        data.banned.forEach(item => {
          const div = document.createElement('div');
          div.style.display = 'flex';
          div.style.justifyContent = 'space-between';
          div.style.alignItems = 'center';
          div.style.padding = '6px 12px';
          div.style.background = 'rgba(255,255,255,0.02)';
          div.style.borderRadius = '4px';
          
          const nameContainer = document.createElement('div');
          const name = document.createElement('strong');
          name.textContent = item.name;
          nameContainer.appendChild(name);
          
          if (item.reason) {
            const reason = document.createElement('div');
            reason.className = 'text-muted text-sm';
            reason.textContent = item.reason;
            nameContainer.appendChild(reason);
          }
          
          const ubBtn = document.createElement('button');
          ubBtn.className = 'btn btn-secondary btn-sm';
          ubBtn.textContent = 'Unban';
          ubBtn.onclick = () => sendPlayerCommand('unban', item.name);
          
          div.appendChild(nameContainer);
          div.appendChild(ubBtn);
          bList.appendChild(div);
        });
      }
    }
    
  } catch (e) {
    console.error('Failed to load lists', e);
  }
}

async function sendPlayerCommand(action, player = '') {
  if (serverData?.status !== 'running') {
    alert('Server must be running to execute player commands.');
    return;
  }
  try {
    await fetch(`/api/servers/${serverId}/players/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, player })
    });
    // Refresh after a small delay to allow server file updates
    setTimeout(() => {
      loadOnlinePlayers();
      if (action !== 'whitelist_on' && action !== 'whitelist_off') {
        loadPlayerLists();
      }
    }, 1000);
  } catch(e) {
    alert('Command failed: ' + e.message);
  }
}

function toggleWhitelist() {
  const btn = document.getElementById('btnToggleWhitelist');
  if (btn) { btn.disabled = true; btn.textContent = 'Toggling...'; }
  
  isWhitelistEnabled = !isWhitelistEnabled;
  sendPlayerCommand(isWhitelistEnabled ? 'whitelist_on' : 'whitelist_off');
  
  const badge = document.getElementById('whitelistStatusBadge');
  if (badge) {
    badge.className = isWhitelistEnabled ? 'badge badge-running' : 'badge badge-stopped';
    badge.textContent = isWhitelistEnabled ? 'Enabled' : 'Disabled';
  }
  
  setTimeout(() => { if (btn) { btn.disabled = false; btn.textContent = 'Toggle Whitelist'; } }, 1500);
}

function addWhitelist() {
  const input = document.getElementById('whitelistAddInput');
  const user = input.value.trim();
  if (!user) return;
  const btn = event?.target;
  if (btn) { btn.disabled = true; btn.textContent = 'Adding...'; }
  sendPlayerCommand('whitelist_add', user);
  input.value = '';
  setTimeout(() => { if (btn) { btn.disabled = false; btn.textContent = 'Add Player'; } }, 1500);
}
