const rawLine = '[00:19:01 INFO]: There are 1 of a max of 20 players online: GamingBurst\r';
const line = rawLine.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
const summaryMatch = line.match(/(?:players online|online players|there are .* online|out of maximum)/i);
if (summaryMatch) {
  const afterSummary = line.substring(summaryMatch.index + summaryMatch[0].length);
  const colonIdx = afterSummary.indexOf(':');
  
  if (colonIdx !== -1) {
    const playersStr = afterSummary.substring(colonIdx + 1).trim();
    if (playersStr.length > 0) {
      const p = playersStr.split(',').map(x => x.trim().replace(/§[0-9a-fk-or]/ig, '')).filter(Boolean);
      console.log('SUCCESS:', p);
    } else {
      console.log('FAIL: playersStr is empty');
    }
  } else {
    console.log('FAIL: no colon found. afterSummary =', afterSummary);
  }
} else {
  console.log('FAIL: no summary match');
}
