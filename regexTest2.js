const regex = /there\s+are\s+(\d+)(?:\s*\/\s*|\s+of\s+a\s+max\s+of\s+)(\d+)\s+players?\s+online(?:[^:]*:)?\s*(.*)$/i;
const match = 'There are 1 of a max of 20 players online: GamingBurst'.match(regex);
console.log('Group 1 (count):', match[1]);
console.log('Group 2 (max):', match[2]);
console.log('Group 3 (players):', match[3]);
