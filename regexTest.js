const regex = /there\s+are\s+(\d+)(?:\s*\/\s*|\s+of\s+a\s+max\s+of\s+)(\d+)\s+players?\s+online(?:[^:]*:)?\s*(.*)$/i;
const str = 'There are 1 of a max of 20 players online: GamingBurst\r';
console.log(str.match(regex));
