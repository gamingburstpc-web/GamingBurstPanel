let currentPlugins = [];

function initPlugins() {
  loadInstalledPlugins();
}

async function loadInstalledPlugins() {
  const container = document.getElementById('installedPluginsList');
  container.innerHTML = '<div style="color:var(--text-muted)">Loading plugins...</div>';
  try {
    // We can list files in the /plugins/ folder via the existing files API!
    const res = await fetch(`/api/servers/${serverId}/files?path=plugins`);
    if (res.status === 404) {
      container.innerHTML = '<div style="color:var(--text-muted)">No plugins folder found.</div>';
      return;
    }
    const files = await res.json();
    if (!files || files.length === 0) {
      container.innerHTML = '<div style="color:var(--text-muted)">No plugins installed.</div>';
      return;
    }
    
    currentPlugins = files.filter(f => f.name.endsWith('.jar') && !f.isDirectory);
    if (currentPlugins.length === 0) {
      container.innerHTML = '<div style="color:var(--text-muted)">No plugins installed.</div>';
      return;
    }
    
    container.innerHTML = currentPlugins.map(p => `
      <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;padding:12px;display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-weight:600;font-size:14px">${p.name}</div>
          <div style="font-size:12px;color:var(--text-muted)">${formatSize(p.size)}</div>
        </div>
        <button class="btn btn-danger btn-sm admin-only" onclick="deletePlugin('${p.name}')">🗑 Delete</button>
      </div>
    `).join('');
  } catch(e) {
    container.innerHTML = `<div style="color:var(--red)">Failed to load plugins.</div>`;
  }
}

async function deletePlugin(filename) {
  if (!confirm(`Are you sure you want to delete ${filename}?`)) return;
  try {
    const res = await fetch(`/api/servers/${serverId}/files/delete`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ path: 'plugins/' + filename })
    });
    if (!res.ok) throw new Error('Delete failed');
    showAlert('success', `Plugin ${filename} deleted.`);
    loadInstalledPlugins();
  } catch (e) {
    showAlert('error', 'Failed to delete plugin.');
  }
}

async function searchPlugins() {
  const query = document.getElementById('pluginSearchInput').value.trim();
  const type = document.getElementById('pluginSortType').value;
  const version = document.getElementById('pluginSortVersion').value;
  const container = document.getElementById('pluginSearchResults');
  
  if (!query && !type && !version) {
    container.innerHTML = '<div style="color:var(--text-muted)">Enter a search term.</div>';
    return;
  }
  
  container.innerHTML = '<div style="color:var(--text-muted)"><span class="spinner"></span> Searching Modrinth...</div>';
  
  try {
    const facets = [["project_type:plugin"]];
    if (type) facets.push([`categories:${type}`]);
    if (version) facets.push([`versions:${version}`]);
    
    const url = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(query)}&facets=${encodeURIComponent(JSON.stringify(facets))}&limit=20`;
    const res = await fetch(url);
    const data = await res.json();
    
    if (data.hits.length === 0) {
      container.innerHTML = '<div style="color:var(--text-muted)">No plugins found.</div>';
      return;
    }
    
    container.innerHTML = data.hits.map(hit => `
      <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:8px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div>
            <div style="font-weight:600;font-size:15px;display:flex;align-items:center;gap:6px">
              ${hit.icon_url ? `<img src="${hit.icon_url}" style="width:20px;height:20px;border-radius:4px">` : ''}
              <a href="https://modrinth.com/plugin/${hit.slug}" target="_blank" style="color:var(--text-primary)">${hit.title}</a>
            </div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">${hit.description}</div>
          </div>
          <button class="btn btn-primary btn-sm admin-only" onclick="installModrinthPlugin('${hit.project_id}')">⬇ Add to Server</button>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
          ${hit.categories.filter(c => ['spigot','paper','bukkit'].includes(c)).map(c => `<span class="badge" style="background:rgba(91,110,255,0.1);color:var(--accent)">${c}</span>`).join('')}
          <span style="font-size:11px;color:var(--text-muted);background:rgba(255,255,255,0.05);padding:2px 6px;border-radius:4px;">MC: ${hit.versions ? (hit.versions.length > 3 ? hit.versions.slice(-3).join(', ') + '...' : hit.versions.join(', ')) : 'Unknown'}</span>
          <span style="font-size:11px;color:var(--text-muted);">Source: Modrinth</span>
          <span style="font-size:11px;color:var(--text-muted);">Downloads: ${hit.downloads}</span>
        </div>
      </div>
    `).join('');
  } catch(e) {
    container.innerHTML = `<div style="color:var(--red)">Search failed: ${e.message}</div>`;
  }
}

async function installModrinthPlugin(projectId) {
  try {
    showAlert('info', 'Finding latest compatible version...');
    // Get versions
    const versionUrl = `https://api.modrinth.com/v2/project/${projectId}/version`;
    const res = await fetch(versionUrl);
    const versions = await res.json();
    
    const targetVersion = document.getElementById('pluginSortVersion').value;
    let selectedVersion = null;
    
    if (targetVersion) {
      selectedVersion = versions.find(v => v.game_versions.includes(targetVersion));
    }
    if (!selectedVersion && versions.length > 0) selectedVersion = versions[0];
    
    if (!selectedVersion || selectedVersion.files.length === 0) {
      throw new Error('No compatible jar file found.');
    }
    
    const file = selectedVersion.files.find(f => f.primary) || selectedVersion.files[0];
    downloadPluginUrl(file.url, file.filename);
  } catch (e) {
    showAlert('error', e.message);
  }
}

function showDirectLinkUpload() {
  const url = prompt("Enter direct URL to the .jar file:");
  if (url) {
    const filename = url.split('/').pop().split('?')[0] || 'plugin.jar';
    downloadPluginUrl(url, filename);
  }
}

async function downloadPluginUrl(url, filename) {
  const progContainer = document.getElementById('pluginProgressContainer');
  const progText = document.getElementById('pluginProgressText');
  const progBar = document.getElementById('pluginProgressBar');
  
  progContainer.classList.remove('hidden');
  progText.innerText = `Downloading ${filename}...`;
  progBar.style.width = '50%';
  
  try {
    const res = await fetch(`/api/servers/${serverId}/plugins/download-url`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ url, filename })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    
    progBar.style.width = '100%';
    showAlert('success', `${filename} installed successfully!`);
    loadInstalledPlugins();
  } catch (e) {
    progBar.style.width = '0%';
    progBar.classList.add('crit');
    showAlert('error', `Download failed: ${e.message}`);
  }
  
  setTimeout(() => {
    progContainer.classList.add('hidden');
    progBar.style.width = '0%';
    progBar.classList.remove('crit');
  }, 3000);
}

function uploadPluginFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  const progContainer = document.getElementById('pluginProgressContainer');
  const progText = document.getElementById('pluginProgressText');
  const progBar = document.getElementById('pluginProgressBar');
  
  progContainer.classList.remove('hidden');
  progText.innerText = `Uploading ${file.name}...`;
  progBar.style.width = '0%';
  
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/servers/${serverId}/files/upload?path=${encodeURIComponent('plugins/' + file.name)}`);
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = (e.loaded / e.total) * 100;
      progBar.style.width = pct + '%';
    }
  };
  
  xhr.onload = () => {
    if (xhr.status === 200) {
      progBar.style.width = '100%';
      showAlert('success', 'Plugin uploaded!');
      loadInstalledPlugins();
    } else {
      progBar.classList.add('crit');
      showAlert('error', 'Upload failed.');
    }
    setTimeout(() => {
      progContainer.classList.add('hidden');
      progBar.style.width = '0%';
      progBar.classList.remove('crit');
    }, 3000);
  };
  
  xhr.send(file);
  event.target.value = '';
}

// Hook into tab switching
const originalSwitchServerTab = window.switchServerTab;
window.switchServerTab = function(tabName) {
  if (originalSwitchServerTab) originalSwitchServerTab(tabName);
  
  document.getElementById('tabConsole').classList.add('hidden');
  document.getElementById('tabFiles').classList.add('hidden');
  document.getElementById('tabPlugins').classList.add('hidden');
  
  document.getElementById('tabBtnConsole').classList.remove('active');
  document.getElementById('tabBtnFiles').classList.remove('active');
  document.getElementById('tabBtnPlugins').classList.remove('active');
  
  if (tabName === 'console') {
    document.getElementById('tabConsole').classList.remove('hidden');
    document.getElementById('tabBtnConsole').classList.add('active');
  } else if (tabName === 'files') {
    document.getElementById('tabFiles').classList.remove('hidden');
    document.getElementById('tabBtnFiles').classList.add('active');
  } else if (tabName === 'plugins') {
    document.getElementById('tabPlugins').classList.remove('hidden');
    document.getElementById('tabBtnPlugins').classList.add('active');
    if (currentPlugins.length === 0) loadInstalledPlugins();
  }
};
