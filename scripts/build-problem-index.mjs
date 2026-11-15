// data/problems/<book>/NNN.txt から index（手数ごとの巻ごと問題数）を生成する
// 使い方: node scripts/build-problem-index.mjs <problems dir> <output json>
import fs from 'node:fs';
import path from 'node:path';

const dest = process.argv[2];
const out = process.argv[3];
const index = {};
for (const book of fs.readdirSync(dest).filter((d) => /^mate\d+$/.test(d)).sort()) {
  const dir = path.join(dest, book);
  const volumes = fs
    .readdirSync(dir)
    .filter((f) => /^\d{3}\.txt$/.test(f))
    .sort()
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => l.trim()).length);
  index[book] = { moves: Number(book.slice(4)), volumes };
}
fs.writeFileSync(out, JSON.stringify(index));
for (const [b, v] of Object.entries(index)) {
  console.log(`${b}: ${v.volumes.length} volumes, ${v.volumes.reduce((a, c) => a + c, 0)} problems`);
}
