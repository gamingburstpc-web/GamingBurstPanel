const rawLine = '[00:19:01 INFO]: There are 1 of a max of 20 players online: GamingBurst\r';
let line = rawLine.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
line = line.replace(/^\[[^\]]*\]:?\s*(\[[^\]]*\]:?\s*)?/i, '').trim();
const regex = /there\s+are\s+(\d+)(?:\s*\/\s*|\s+of\s+a\s+max\s+of\s+)(\d+)\s+players?\s+online(?:[^:]*:)?\s*(.*)$/i;
console.log(line.match(regex));
