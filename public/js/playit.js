'use strict';

let playitPollInterval = null;

async function loadPlayitStatus() {
  try {
    const res = await fetch(`/api/servers/${serverId}/playit/status`);
    if (res.status === 404) return;
    const data = await res.json();
    
    document.getElementById('playitStateDownload').classList.add('hidden');
    document.getElementById('playitStateSetup').classList.add('hidden');
    document.getElementById('playitStateActive').classList.add('hidden');
    document.getElementById('playitSetupClaim').classList.add('hidden');
    document.getElementById('playitSetupSecret').classList.add('hidden');
    
    if (data.status === 'not_installed') {
      document.getElementById('playitStateDownload').classList.remove('hidden');
    } else if (data.status === 'installed') {
      document.getElementById('playitStateSetup').classList.remove('hidden');
    } else if (['claiming', 'starting', 'crashed'].includes(data.status)) {
      document.getElementById('playitStateSetup').classList.remove('hidden');
      document.getElementById('playitSetupClaim').classList.remove('hidden');
      if (data.status === 'crashed') {
        const a = document.getElementById('playitClaimLink');
        a.removeAttribute('href');
        a.innerText = 'Process Crashed (See logs below)';
        a.style.color = 'var(--danger)';
      } else if (data.claimLink) {
        const a = document.getElementById('playitClaimLink');
        a.href = data.claimLink;
        a.innerText = data.claimLink;
      } else {
        const a = document.getElementById('playitClaimLink');
        a.removeAttribute('href');
        a.innerText = 'Generating...';
      }
      
      const logBox = document.getElementById('playitLogBox');
      if (logBox && data.logs) {
        logBox.classList.remove('hidden');
        logBox.innerText = data.logs;
        logBox.scrollTop = logBox.scrollHeight;
      }
      
      if (!playitPollInterval) playitPollInterval = setInterval(loadPlayitStatus, 3000);
    } else if (data.status === 'connected') {
      if (playitPollInterval) { clearInterval(playitPollInterval); playitPollInterval = null; }
      document.getElementById('playitStateActive').classList.remove('hidden');
      
      const list = document.getElementById('playitTunnelsList');
      if (data.tunnels && data.tunnels.length > 0) {
        list.innerHTML = data.tunnels.map(t => `
          <div style="background:rgba(255,255,255,0.05);padding:12px;border-radius:8px;">
            <div style="font-weight:600;color:var(--text-primary)">${t.name || 'Unnamed Tunnel'}</div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:4px">
              Protocol: <span style="color:var(--accent)">${t.proto}</span> | IP: <span style="font-family:monospace;color:var(--text-primary)">${t.ip}</span>
            </div>
          </div>
        `).join('');
      } else {
        list.innerHTML = `<div class="text-muted text-sm">Your server is connected to the Playit network! Tunnels are active in the background. Manage your domains directly on the <a href="https://playit.gg" target="_blank" style="color:var(--accent);text-decoration:none;font-weight:600">Playit.gg Dashboard</a>.</div>`;
      }
    }
  } catch (e) {
    console.error('Playit status error:', e);
  }
}

async function downloadPlayit() {
  const btn = document.getElementById('btnDownloadPlayit');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Downloading...';
  try {
    const res = await fetch(`/api/servers/${serverId}/playit/download`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showAlert('success', 'Playit downloaded successfully!');
    loadPlayitStatus();
  } catch (e) {
    showAlert('error', 'Download failed: ' + e.message);
    btn.disabled = false;
    btn.innerHTML = '⬇ Download Playit Binary';
  }
}

function showPlayitSecret() {
  document.getElementById('playitSetupClaim').classList.add('hidden');
  document.getElementById('playitSetupSecret').classList.remove('hidden');
  if (serverData && serverData.port) {
    document.getElementById('playitSecretPort').innerText = serverData.port;
  }
}

async function showPlayitClaim() {
  document.getElementById('playitSetupSecret').classList.add('hidden');
  document.getElementById('playitSetupClaim').classList.remove('hidden');
  document.getElementById('playitClaimLink').innerText = 'Generating...';
  document.getElementById('playitClaimLink').href = '#';
  
  if (serverData && serverData.port) {
    document.getElementById('playitJavaPort').innerText = serverData.port;
  }
  
  try {
    const res = await fetch(`/api/servers/${serverId}/playit/claim`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    loadPlayitStatus(); // Will start polling
  } catch (e) {
    showAlert('error', 'Failed to generate claim link: ' + e.message);
  }
}

async function savePlayitSecret() {
  const secret = document.getElementById('playitSecretInput').value.trim();
  if (!secret) return;
  try {
    const res = await fetch(`/api/servers/${serverId}/playit/secret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showAlert('success', 'Secret key saved!');
    loadPlayitStatus();
  } catch (e) {
    showAlert('error', 'Failed to save secret: ' + e.message);
  }
}

async function resetPlayit() {
  if (!confirm('Are you sure you want to reset Playit? You will need to claim it again.')) return;
  try {
    const res = await fetch(`/api/servers/${serverId}/playit/reset`, { method: 'POST' });
    if (!res.ok) throw new Error('Reset failed');
    loadPlayitStatus();
  } catch (e) {
    showAlert('error', e.message);
  }
}


