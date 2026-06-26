const https = require('https');
function fetchPage(page) {
  https.get(`https://api.github.com/repos/playit-cloud/playit-agent/releases?page=${page}&per_page=100`, {headers:{'User-Agent':'Node'}}, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      const data = JSON.parse(d);
      if(!data || data.length === 0) return;
      const release = data.find(r => r.tag_name === 'v0.9.3' || r.tag_name === 'v0.14.0' || r.tag_name === '0.9.3');
      if (release) {
        release.assets.forEach(a => {
          if (a.name.includes('linux') && a.name.includes('amd64')) console.log(release.tag_name + ' -> ' + a.browser_download_url);
        });
      } else {
        fetchPage(page + 1);
      }
    });
  });
}
fetchPage(1);
