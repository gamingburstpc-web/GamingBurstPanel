// settings.js

let currentSettings = { motd: '', onlineMode: true, antiXray: false, antiXrayEngine: 1 };

async function loadSettings() {
  try {
    const res = await fetch(`/api/servers/${serverId}/settings`);
    if (res.ok) {
      currentSettings = await res.json();
      
      const motdInput = document.getElementById('settingsMotdInput');
      const motdColor = document.getElementById('settingsMotdColor');
      if (motdInput) {
        let rawMotd = currentSettings.motd || '';
        let extractedHex = '#ffffff'; // default
        
        // Check if motd starts with \u00A7x hex sequence
        const hexMatch = rawMotd.match(/^\\u00A7x(?:\\u00A7([0-9a-fA-F])){6}/);
        if (hexMatch) {
          const rawCode = hexMatch[0];
          extractedHex = '#' + rawCode.replace(/\\u00A7x/g, '').replace(/\\u00A7/g, '');
          rawMotd = rawMotd.substring(rawCode.length);
        }
        
        motdInput.value = rawMotd;
        if (motdColor) motdColor.value = extractedHex;
      }
      
      const crackedBtn = document.getElementById('btnToggleCracked');
      if (crackedBtn) {
        if (!currentSettings.onlineMode) {
          crackedBtn.textContent = 'Enabled';
          crackedBtn.className = 'btn btn-primary';
        } else {
          crackedBtn.textContent = 'Disabled';
          crackedBtn.className = 'btn btn-secondary';
        }
      }
      
      const antiXrayBtn = document.getElementById('btnToggleAntiXray');
      const antiXrayEngineDiv = document.getElementById('antiXrayEngineDiv');
      const antiXrayEngineSelect = document.getElementById('settingsAntiXrayEngine');
      
      if (antiXrayBtn && antiXrayEngineDiv && antiXrayEngineSelect) {
        if (currentSettings.antiXray) {
          antiXrayBtn.textContent = 'Enabled';
          antiXrayBtn.className = 'btn btn-primary';
          antiXrayEngineDiv.style.display = 'flex';
          antiXrayEngineSelect.value = currentSettings.antiXrayEngine || 1;
        } else {
          antiXrayBtn.textContent = 'Disabled';
          antiXrayBtn.className = 'btn btn-secondary';
          antiXrayEngineDiv.style.display = 'none';
        }
      }
    }
  } catch (e) {
    console.error('Failed to load settings', e);
  }
}

async function updateServerVersion() {
  const type = document.getElementById('settingsVersionType').value;
  const value = document.getElementById('settingsVersionInput').value.trim();
  const btn = document.getElementById('btnUpdateVersion');
  
  if (!value) return window.showAlert('Please enter a version or URL.');
  
  if (!confirm('Are you sure you want to change the server version? We recommend making a backup first if you are downgrading.')) return;
  
  btn.disabled = true;
  btn.textContent = 'Updating...';
  
  try {
    const res = await fetch(`/api/servers/${serverId}/settings/version`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, value })
    });
    const data = await res.json();
    if (data.ok) {
      window.showAlert('Server version updated! Please restart the server for the new version to apply.');
    } else {
      window.showAlert('Error: ' + data.error);
    }
  } catch (e) {
    window.showAlert('Failed to update version: ' + e.message);
  }
  
  btn.disabled = false;
  btn.textContent = 'Update Version';
}

async function updateServerProperties() {
  let motd = document.getElementById('settingsMotdInput').value;
  const motdColor = document.getElementById('settingsMotdColor');
  
  if (motdColor && motdColor.value && motdColor.value !== '#ffffff') {
    // Convert #RRGGBB to \u00A7x\u00A7R\u00A7R\u00A7G\u00A7G\u00A7B\u00A7B
    const hex = motdColor.value.substring(1);
    let mcColor = '\\u00A7x';
    for (let i = 0; i < hex.length; i++) {
      mcColor += '\\u00A7' + hex[i];
    }
    motd = mcColor + motd;
  }
  
  const btn = document.getElementById('btnSaveProperties');
  
  btn.disabled = true;
  btn.textContent = 'Saving...';
  
  try {
    const res = await fetch(`/api/servers/${serverId}/settings/properties`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ motd, onlineMode: currentSettings.onlineMode })
    });
    if (res.ok) {
      window.showAlert('Properties saved! Restart required.');
    }
  } catch (e) {
    window.showAlert('Failed to save properties.');
  }
  
  btn.disabled = false;
  btn.textContent = 'Save';
}

async function toggleCracked() {
  currentSettings.onlineMode = !currentSettings.onlineMode;
  try {
    const res = await fetch(`/api/servers/${serverId}/settings/properties`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ motd: currentSettings.motd, onlineMode: currentSettings.onlineMode })
    });
    if (res.ok) loadSettings();
  } catch (e) {
    window.showAlert('Failed to toggle cracked mode.');
    currentSettings.onlineMode = !currentSettings.onlineMode;
  }
}

function uploadServerLogo() {
  const fileInput = document.getElementById('settingsLogoInput');
  const file = fileInput.files[0];
  const btn = document.getElementById('btnUploadLogo');
  
  if (!file) return window.showAlert('Please select an image file.');
  
  btn.disabled = true;
  btn.textContent = 'Processing...';
  
  const img = new Image();
  const reader = new FileReader();
  
  reader.onload = (e) => {
    img.src = e.target.result;
    img.onload = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, 64, 64);
      
      const base64 = canvas.toDataURL('image/png');
      
      try {
        const res = await fetch(`/api/servers/${serverId}/settings/logo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: base64 })
        });
        if (res.ok) {
          window.showAlert('Server logo updated! Restart required.');
          fileInput.value = '';
        } else {
          const data = await res.json();
          window.showAlert('Error: ' + data.error);
        }
      } catch (e) {
        window.showAlert('Failed to upload logo.');
      }
      
      btn.disabled = false;
      btn.textContent = 'Upload Logo';
    };
  };
  reader.readAsDataURL(file);
}

async function toggleAntiXray() {
  currentSettings.antiXray = !currentSettings.antiXray;
  await saveAntiXray();
}

async function updateAntiXrayEngine() {
  currentSettings.antiXrayEngine = document.getElementById('settingsAntiXrayEngine').value;
  await saveAntiXray();
}

async function saveAntiXray() {
  try {
    const res = await fetch(`/api/servers/${serverId}/settings/antixray`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: currentSettings.antiXray, engine: currentSettings.antiXrayEngine })
    });
    if (res.ok) loadSettings();
  } catch (e) {
    window.showAlert('Failed to save Anti-Xray settings.');
  }
}

// Hook into existing switchServerTab
const _originalSwitchServerTab = window.switchServerTab;
window.switchServerTab = function(tabName) {
  if (typeof _originalSwitchServerTab === 'function') {
    _originalSwitchServerTab(tabName);
  }
  if (tabName === 'settings') {
    loadSettings();
  }
};
