const https = require('https');
https.get('https://api.github.com/repos/playit-cloud/playit-agent/releases', {headers:{'User-Agent':'Node'}}, res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    const data = JSON.parse(d);
    data.forEach(r => {
      if (r.tag_name === 'v0.9.3' || r.tag_name === 'v0.14.0' || r.tag_name === '0.9.3') {
        console.log(r.tag_name);
        r.assets.forEach(a => {
          if (a.name.includes('linux') && a.name.includes('amd64')) console.log('  ' + a.browser_download_url);
        });
      }
    });
  });
});
