'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const registry = new Map(); // serverId -> { proc, claimLink, status }

function getPlayitPath(serverDir) {
  try {
    const stdout = require('child_process').execSync('which playit', { stdio: 'pipe' }).toString().trim();
    if (stdout && fs.existsSync(stdout)) return stdout;
  } catch(e) {}
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

  let env = { ...process.env };
  if (fs.existsSync(tomlPath)) {
    try {
      const content = fs.readFileSync(tomlPath, 'utf8');
      const match = content.match(/secret_key\s*=\s*'([^']+)'/);
      if (match) env.SECRET_KEY = match[1];
      else env.SECRET_KEY = content.trim();
    } catch (e) {}
  }

  const proc = spawn(playitBin, ['--secret_path', tomlPath], {
    cwd: serverDir,
    env: env,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const entry = { proc, claimLink: null, status: 'starting', logs: '' };
  registry.set(serverId, entry);

  const onData = (data) => {
    const output = data.toString();
    entry.logs += output;
    if (entry.logs.length > 5000) entry.logs = entry.logs.slice(-5000);
    console.log('[Playit]', output.trim());
    if (!fs.existsSync(tomlPath)) {
      const match = output.match(/https?:\/\/[a-zA-Z0-9\.\-]+\/[a-zA-Z0-9\/]+/);
      if (match && match[0].includes('playit')) {
        entry.claimLink = match[0];
        entry.status = 'claiming';
      }
    } else {
      entry.status = 'connected';
      entry.claimLink = null;
    }
  };

  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  proc.on('close', (code) => {
    entry.status = 'crashed';
    entry.logs += `\n[Info] Playit process exited with code ${code}`;
  });
  proc.on('error', (err) => {
    entry.status = 'crashed';
    entry.logs += `\n[Error] Failed to spawn playit: ${err.message}`;
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

  const entry = registry.get(serverId);
  if (entry) {
    if (['starting', 'claiming', 'crashed'].includes(entry.status)) {
      return { status: entry.status, claimLink: entry.claimLink, logs: entry.logs };
    }
  }

  if (fs.existsSync(tomlPath)) {
    if (!entry) startPlayit(serverId, serverDir);
    return { status: 'connected', tunnels: [] };
  }

  return { status: 'installed' };
}

function setupClaim(serverId, serverDir) {
  const tomlPath = getTomlPath(serverDir);
  if (fs.existsSync(tomlPath)) fs.unlinkSync(tomlPath);
  stopPlayit(serverId);
  startPlayit(serverId, serverDir);
}

function setupSecret(serverId, serverDir, secret) {
  const tomlPath = getTomlPath(serverDir);
  fs.writeFileSync(tomlPath, `secret_key='${secret}'\n`);
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
