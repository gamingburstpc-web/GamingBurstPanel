const https = require('https');
const fs = require('fs');

const url = 'https://download.geysermc.org/v2/projects/geyser/versions/latest/builds/latest/downloads/spigot';

function testDownload() {
  https.get(url, (res) => {
    console.log('Status code:', res.statusCode);
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      const redirectUrl = new URL(res.headers.location, url).href;
      console.log('Redirecting to:', redirectUrl);
      
      const client = redirectUrl.startsWith('https') ? https : require('http');
      client.get(redirectUrl, (res2) => {
        console.log('Redirect 1 status code:', res2.statusCode);
        console.log('Headers:', res2.headers);
        if (res2.statusCode >= 300 && res2.statusCode < 400 && res2.headers.location) {
            const redirectUrl2 = new URL(res2.headers.location, redirectUrl).href;
            console.log('Redirecting again to:', redirectUrl2);
            
            const client2 = redirectUrl2.startsWith('https') ? https : require('http');
            client2.get(redirectUrl2, (res3) => {
                console.log('Redirect 2 status code:', res3.statusCode);
            });
        }
      }).on('error', console.error);
    }
  }).on('error', console.error);
}

testDownload();
