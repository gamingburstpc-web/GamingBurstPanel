const ct = require('countries-and-timezones');
const fs = require('fs');
const path = require('path');

async function cmdTimezoneConfig(ask, print, C, success, error) {
  print(`\n${C.bold}--- Panel Timezone Configuration ---${C.reset}\n`);
  
  // Read current timezone
  const envPath = path.join(process.cwd(), '.env');
  let currentTz = 'Not Set (Defaults to System)';
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const match = envContent.match(/^DEFAULT_TZ=(.*)$/m);
    if (match) currentTz = match[1];
  }
  
  print(`Current Timezone: ${C.cyan}${currentTz}${C.reset}\n`);
  
  print(`Select a method to find your timezone:`);
  print(`  ${C.cyan}1.${C.reset} Select by Continent & Region`);
  print(`  ${C.cyan}2.${C.reset} Search by Country Name`);
  print(`  ${C.cyan}3.${C.reset} Select from Common Timezones`);
  print(`  ${C.cyan}0.${C.reset} Cancel`);
  
  const opt = await ask('\nEnter a number [0-3]: ');
  
  let selectedTz = null;
  
  if (opt === '1') {
    selectedTz = await selectByContinent(ask, print, C);
  } else if (opt === '2') {
    selectedTz = await searchByCountry(ask, print, C);
  } else if (opt === '3') {
    selectedTz = await selectCommon(ask, print, C);
  } else {
    print('Cancelled.');
    return;
  }
  
  if (selectedTz) {
    print(`\nYou selected: ${C.bold}${C.green}${selectedTz}${C.reset}`);
    const confirm = await ask('Apply this timezone? (y/n): ');
    if (confirm.toLowerCase() === 'y') {
      try {
        let envContent = '';
        if (fs.existsSync(envPath)) {
          envContent = fs.readFileSync(envPath, 'utf8');
        }
        
        if (envContent.match(/^DEFAULT_TZ=/m)) {
          envContent = envContent.replace(/^DEFAULT_TZ=.*$/m, `DEFAULT_TZ=${selectedTz}`);
        } else {
          envContent += `\nDEFAULT_TZ=${selectedTz}\n`;
        }
        
        fs.writeFileSync(envPath, envContent);
        success(`\nTimezone successfully updated to ${selectedTz}!`);
        print(`${C.yellow}IMPORTANT:${C.reset} Please restart the panel service for changes to take effect.`);
        print(`You can do this by running: ${C.dim}sudo gbpanel${C.reset} and selecting ${C.cyan}Restart Panel Service${C.reset}`);
      } catch(e) {
        error(`Failed to save .env file: ${e.message}`);
      }
    } else {
      print('Cancelled.');
    }
  }
}

async function selectByContinent(ask, print, C) {
  const tzs = Intl.supportedValuesOf('timeZone');
  const continents = [...new Set(tzs.map(tz => tz.split('/')[0]))].filter(c => c !== 'Etc' && c !== 'SystemV');
  
  print(`\n${C.bold}Select Continent/Region:${C.reset}`);
  continents.forEach((c, i) => print(`  ${C.cyan}${i+1}.${C.reset} ${c}`));
  const cIdx = parseInt(await ask(`Enter number [1-${continents.length}]: `), 10);
  
  if (isNaN(cIdx) || cIdx < 1 || cIdx > continents.length) {
    print('Invalid selection.');
    return null;
  }
  
  const selectedContinent = continents[cIdx - 1];
  const regionTzs = tzs.filter(tz => tz.startsWith(selectedContinent + '/'));
  
  // Pagination
  let page = 0;
  const perPage = 20;
  
  while(true) {
    const start = page * perPage;
    const end = Math.min(start + perPage, regionTzs.length);
    const chunk = regionTzs.slice(start, end);
    
    print(`\n${C.bold}Timezones in ${selectedContinent} (Page ${page + 1}/${Math.ceil(regionTzs.length/perPage)}):${C.reset}`);
    chunk.forEach((tz, i) => print(`  ${C.cyan}${start + i + 1}.${C.reset} ${tz}`));
    
    let promptText = `Enter number [1-${regionTzs.length}]`;
    if (end < regionTzs.length) promptText += ` or 'n' for next page`;
    if (page > 0) promptText += ` or 'p' for previous page`;
    promptText += ` ('q' to quit): `;
    
    const input = (await ask(promptText)).toLowerCase();
    
    if (input === 'q') return null;
    if (input === 'n' && end < regionTzs.length) { page++; continue; }
    if (input === 'p' && page > 0) { page--; continue; }
    
    const tzIdx = parseInt(input, 10);
    if (!isNaN(tzIdx) && tzIdx >= 1 && tzIdx <= regionTzs.length) {
      return regionTzs[tzIdx - 1];
    }
    
    print('Invalid input, try again.');
  }
}

async function searchByCountry(ask, print, C) {
  const query = (await ask('\nEnter country name (e.g. "India", "United States", "Brazil"): ')).toLowerCase();
  
  const allCountries = ct.getAllCountries();
  const matches = Object.values(allCountries).filter(c => c.name.toLowerCase().includes(query));
  
  if (matches.length === 0) {
    print(`No countries found matching "${query}".`);
    return null;
  }
  
  let selectedCountry = matches[0];
  if (matches.length > 1) {
    print(`\nMultiple matches found:`);
    matches.forEach((c, i) => print(`  ${C.cyan}${i+1}.${C.reset} ${c.name}`));
    const cIdx = parseInt(await ask(`Select country [1-${matches.length}]: `), 10);
    if (isNaN(cIdx) || cIdx < 1 || cIdx > matches.length) {
      print('Invalid selection.');
      return null;
    }
    selectedCountry = matches[cIdx - 1];
  }
  
  const tzs = selectedCountry.timezones;
  if (tzs.length === 0) {
    print(`No timezones found for ${selectedCountry.name}.`);
    return null;
  }
  
  if (tzs.length === 1) {
    print(`\nFound timezone for ${selectedCountry.name}: ${tzs[0]}`);
    return tzs[0];
  }
  
  print(`\n${C.bold}Timezones in ${selectedCountry.name}:${C.reset}`);
  tzs.forEach((tz, i) => print(`  ${C.cyan}${i+1}.${C.reset} ${tz}`));
  const tzIdx = parseInt(await ask(`Select timezone [1-${tzs.length}]: `), 10);
  
  if (isNaN(tzIdx) || tzIdx < 1 || tzIdx > tzs.length) {
    print('Invalid selection.');
    return null;
  }
  return tzs[tzIdx - 1];
}

async function selectCommon(ask, print, C) {
  const common = [
    { name: 'UTC (Universal Coordinated Time)', tz: 'UTC' },
    { name: 'IST (India Standard Time)', tz: 'Asia/Kolkata' },
    { name: 'EST/EDT (US Eastern Time)', tz: 'America/New_York' },
    { name: 'CST/CDT (US Central Time)', tz: 'America/Chicago' },
    { name: 'PST/PDT (US Pacific Time)', tz: 'America/Los_Angeles' },
    { name: 'GMT/BST (UK Time)', tz: 'Europe/London' },
    { name: 'CET/CEST (Central European Time)', tz: 'Europe/Berlin' },
    { name: 'AEST/AEDT (Australian Eastern Time)', tz: 'Australia/Sydney' },
    { name: 'JST (Japan Standard Time)', tz: 'Asia/Tokyo' },
    { name: 'BRT (Brasilia Time)', tz: 'America/Sao_Paulo' }
  ];
  
  print(`\n${C.bold}Common Timezones:${C.reset}`);
  common.forEach((c, i) => print(`  ${C.cyan}${i+1}.${C.reset} ${c.name} - ${C.dim}${c.tz}${C.reset}`));
  
  const tzIdx = parseInt(await ask(`Select timezone [1-${common.length}]: `), 10);
  if (isNaN(tzIdx) || tzIdx < 1 || tzIdx > common.length) {
    print('Invalid selection.');
    return null;
  }
  return common[tzIdx - 1].tz;
}

module.exports = { cmdTimezoneConfig };
