const fs = require('fs');
const s = fs.readFileSync('c:/Users/harve/Desktop/Gobang auto/engine-server/resources/bookmarklet.js', 'utf8');
const pats = ['pendingSide', 'pendingSideCount', 'stableFp', 'stableCount', 'autoClick(', 'function poll', '__gbTimer', '.lastFp', 'S.analyzingAt'];
for (const p of pats) console.log(JSON.stringify(p), '=>', (s.split(p).length - 1));
console.log('---sample lastFp lines---');
s.split('\n').forEach((l, i) => { if (l.indexOf('lastFp') >= 0 && i < 40) console.log(i + 1, l); });