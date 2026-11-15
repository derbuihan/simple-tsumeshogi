// 最低限の持ち駒にした局面を、余り駒を玉方に渡す(A)／取り除く(B) の2通りで作り、
// 攻方番から通常探索して「N手以内の詰み」が残るか・時間を測る（docs/minimal-hand.md 参照）
//
// 使い方（リポジトリ直下で。問題データは npm run fetch:problems で .cache/shogimate に取得しておく）:
//   node docs/minimal-hand/minhand-verify.mjs "$PWD" 30 3000      # 各手数30問、探索3秒
// 環境変数: BOOKS=mate3,mate7（対象の手数）, SHOWFAIL=1（詰まなかった局面を表示）, DBG=1（USI のやりとりを表示）
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const ROOT = process.argv[2]; const PER = Number(process.argv[3] ?? 30); const MOVETIME = Number(process.argv[4] ?? 3000);
const require = createRequire(import.meta.url);
const dir = path.join(ROOT, 'public/engine');
const engine = await require(path.join(dir, 'yaneuraou.mini.js'))({ wasmBinary: fs.readFileSync(path.join(dir, 'yaneuraou.mini.wasm')), locateFile: (f) => path.join(dir, f) });
engine.FS.mkdir('/eval'); for (const f of ['nn.bin', 'progress.bin', 'eval_options.txt']) engine.FS.writeFile(`/eval/${f}`, fs.readFileSync(path.join(dir, 'eval/mini', f)));
let waiter = null; const lines = [];
engine.addMessageListener((l) => { if (process.env.DBG && !l.startsWith("info depth")) console.error("<", l); lines.push(l); if (waiter && waiter.pred(l)) { const w = waiter; waiter = null; w.res(lines.splice(0)); } });
// Emscripten の pthread（Node の worker）はイベントループを維持しないので、タイマーで Node を生かしておく
setInterval(() => {}, 1000);
const until = (pred) => new Promise((res) => (waiter = { pred, res }));
const send = (c) => engine.postMessage(c);
send('usi'); await until((l) => l === 'usiok');
for (const [k, v] of [['Threads', 1], ['USI_Hash', 16], ['EvalDir', '/eval'], ['NetworkDelay', 0], ['NetworkDelay2', 0], ['MinimumThinkingTime', 100]]) send(`setoption name ${k} value ${v}`);
send('isready'); await until((l) => l === 'readyok');
send('position startpos'); send('e'); send('isready'); await until((l) => l === 'readyok');

const ORDER = 'RBGSNLP';
const sqKey = (s) => s.slice(0, 2);
function parseHand(h) { const c = { b: {}, w: {} }; let n = ''; if (h === '-') return c; for (const ch of h) { if (/\d/.test(ch)) { n += ch; continue; } const col = ch === ch.toUpperCase() ? 'b' : 'w'; c[col][ch.toUpperCase()] = (c[col][ch.toUpperCase()] ?? 0) + Number(n || 1); n = ''; } return c; }
function handStr(c) { let s = ''; for (const col of ['b', 'w']) for (const t of ORDER) { const n = c[col][t] ?? 0; if (n) s += (n > 1 ? n : '') + (col === 'b' ? t : t.toLowerCase()); } return s || '-'; }
function boardMap(b) { const m = new Map(); let r = 0; for (const row of b.split('/')) { let f = 9, p = false; for (const ch of row) { if (ch === '+') { p = true; continue; } if (/\d/.test(ch)) { f -= Number(ch); continue; } m.set(`${f}${String.fromCharCode(97 + r)}`, { t: ch.toUpperCase() }); f--; p = false; } r++; } return m; }
function minimalNeed(board, turn, moves) {
  const bm = boardMap(board); const need = {}; const avail = {}; let col = turn;
  for (const m of moves) {
    if (m[1] === '*') { const t = m[0]; if (col === turn) { if (avail[t] > 0) avail[t]--; else need[t] = (need[t] ?? 0) + 1; } bm.set(m.slice(2, 4), { t }); }
    else { const cap = bm.get(m.slice(2, 4)); if (cap && col === turn) avail[cap.t] = (avail[cap.t] ?? 0) + 1; bm.set(m.slice(2, 4), bm.get(m.slice(0, 2))); bm.delete(m.slice(0, 2)); }
    col = col === 'b' ? 'w' : 'b';
  }
  return need;
}
async function solve(sfen) {
  if (process.env.DBG) console.error("POS", sfen); send(`position sfen ${sfen}`); lines.length = 0; const t0 = Date.now();
  send(`go movetime ${MOVETIME}`); const out = await until((l) => l.startsWith('bestmove'));
  let score = null; for (const l of out) { const m = l.match(/score (cp|mate) (\S+)/); if (m) score = m[1] === 'mate' ? Number(m[2]) : null; } if (process.env.SHOWFAIL) lastOut = out.filter((l) => l.includes('score')).slice(-1)[0] ?? out.at(-1);
  return { mate: score, ms: Date.now() - t0 };
}
const res = {}; let lastOut = '';
for (const book of (process.env.BOOKS ?? 'mate3,mate5,mate7,mate9,mate11').split(',')) {
  const N = Number(book.slice(4)); const recs = fs.readFileSync(path.join(ROOT, '.cache/shogimate/public/data', book, '321.txt'), 'utf8').split('\n').filter(Boolean).slice(0, PER);
  const r = { A: { ok: 0, ms: [] }, B: { ok: 0, ms: [] }, orig: { ok: 0, ms: [] } };
  for (const rec of recs) {
    const [sfen, mv] = rec.split(' moves '); const [board, turn, hand, ply] = sfen.split(' '); const moves = mv.trim().split(/\s+/);
    const need = minimalNeed(board, turn, moves); const h = parseHand(hand); const def = turn === 'b' ? 'w' : 'b';
    const hb = { [turn]: { ...need }, [def]: { ...h[def] } };
    const ha = { [turn]: { ...need }, [def]: { ...h[def] } };
    for (const t of ORDER) { const extra = (h[turn][t] ?? 0) - (need[t] ?? 0); if (extra > 0) ha[def][t] = (ha[def][t] ?? 0) + extra; }
    for (const [k, hh] of [['orig', h], ['A', ha], ['B', hb]]) {
      const s = await solve(`${board} ${turn} ${handStr(hh)} ${ply}`);
      if (s.mate !== null && s.mate > 0 && s.mate <= N) r[k].ok++; else if (process.env.SHOWFAIL && k !== 'orig') console.log(`FAIL ${k} mate=${s.mate} [${(lastOut||'').replace(/ pv .*/, ' pv …').slice(-80)}] ${board} ${turn} ${handStr(hh)} ${ply} | 元の持ち駒 ${hand} | 解 ${moves.join(' ')}`); r[k].ms.push(s.ms);
    }
  }
  const avg = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
  console.log(`${book}: 元のまま ${r.orig.ok}/${PER}（平均${avg(r.orig.ms)}ms）  A:玉方に渡す ${r.A.ok}/${PER}（平均${avg(r.A.ms)}ms）  B:取り除く ${r.B.ok}/${PER}（平均${avg(r.B.ms)}ms）`);
}
engine.terminate(); process.exit(0);
