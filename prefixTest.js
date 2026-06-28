const str = '[00:19:01 INFO]: There are 1 of a max of 20 players online: GamingBurst';
const replaced = str.replace(/^\[[^\]]*\]:?\s*(\[[^\]]*\]:?\s*)?/i, '').trim();
console.log(replaced);
