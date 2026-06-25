'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const registry = new Map(); // serverId -> { proc, claimLink, status }

function getPlayitPath(serverDir) {
  return path.join(serverDir, 'playit');
}

function getTomlPath(serverDir) {
  return path.join(serverDir, 'playit.toml');
}

async function downloadPlayit(serverDir) {
  return new Promise((resolve, reject) => {
    const dest = getPlayitPath(serverDir);
    const file = fs.createWriteStream(dest);
    const get = (url) => {
      https.get(url, { headers: { 'User-Agent': 'GamingBurst-Panel/1.0' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) return get(res.headers.location);
        if (res.statusCode !== 200) return reject(new Error('Download failed: ' + res.statusCode));
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            fs.chmodSync(dest, '755'); // make executable
            resolve();
          });
        });
      }).on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    };
    get('https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-linux-amd64');
  });
}

function startPlayit(serverId, serverDir) {
  if (registry.has(serverId)) return;

  const playitBin = getPlayitPath(serverDir);
  const tomlPath = getTomlPath(serverDir);

  if (!fs.existsSync(playitBin)) return; // not downloaded

  const proc = spawn(playitBin, ['--secret_path', tomlPath], {
    cwd: serverDir,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const entry = { proc, claimLink: null, status: 'starting' };
  registry.set(serverId, entry);

  const onData = (data) => {
    const output = data.toString();
    // Look for claim link in output
    if (!fs.existsSync(tomlPath)) {
      const match = output.match(/(https:\/\/playit\.gg\/claim\/[a-zA-Z0-9]+)/);
      if (match) {
        entry.claimLink = match[1];
        entry.status = 'claiming';
      }
    } else {
      entry.status = 'connected';
      entry.claimLink = null;
    }
  };

  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  proc.on('close', () => {
    registry.delete(serverId);
  });
  proc.on('error', () => {
    registry.delete(serverId);
  });
}

function stopPlayit(serverId) {
  const entry = registry.get(serverId);
  if (entry && entry.proc) {
    try { entry.proc.kill('SIGKILL'); } catch (e) {}
    registry.delete(serverId);
  }
}

function getStatus(serverId, serverDir) {
  const playitBin = getPlayitPath(serverDir);
  const tomlPath = getTomlPath(serverDir);

  if (!fs.existsSync(playitBin)) return { status: 'not_installed' };

  if (fs.existsSync(tomlPath)) {
    // Make sure it's running
    if (!registry.has(serverId)) startPlayit(serverId, serverDir);
    return { status: 'connected', tunnels: [] }; // We could parse tunnels if we had API, but keeping it simple for now
  }

  // Installed, but no toml. Check if it's currently claiming.
  const entry = registry.get(serverId);
  if (entry && entry.status === 'claiming' && entry.claimLink) {
    return { status: 'claiming', claimLink: entry.claimLink };
  }

  return { status: 'installed' };
}

function setupClaim(serverId, serverDir) {
  // If we don't have toml, starting it will automatically generate the claim link
  stopPlayit(serverId);
  startPlayit(serverId, serverDir);
}

function setupSecret(serverId, serverDir, secret) {
  const tomlPath = getTomlPath(serverDir);
  fs.writeFileSync(tomlPath, `secret_key="${secret}"\n`);
  stopPlayit(serverId);
  startPlayit(serverId, serverDir);
}

function resetPlayit(serverId, serverDir) {
  const tomlPath = getTomlPath(serverDir);
  if (fs.existsSync(tomlPath)) fs.unlinkSync(tomlPath);
  stopPlayit(serverId);
}

module.exports = {
  downloadPlayit,
  startPlayit,
  stopPlayit,
  getStatus,
  setupClaim,
  setupSecret,
  resetPlayit
};
