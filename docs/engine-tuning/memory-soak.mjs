// アプリと同じ使い方（置換表を問題の間で空にしない）で mini と詰み専用エンジンを続けて動かし、WASM のメモリが増え続けないかを見る。
// 11手詰・9手詰の 003 巻から N 問ずつ。収録解の攻方の手と、初手以外の最初の王手を、アプリと同じ持ち時間で判定する。
// 使い方（リポジトリ直下で）: node docs/engine-tuning/memory-soak.mjs "$PWD" <N>
setInterval(() => {}, 1000);
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const ROOT = process.argv[2]; const N = +process.argv[3];
const mems = []; const Orig = WebAssembly.Memory;
WebAssembly.Memory = function (d) { const m = new Orig(d); mems.push(m); return m; }; WebAssembly.Memory.prototype = Orig.prototype;
const require = createRequire(import.meta.url); const dir = path.join(ROOT, 'public/engine');
async function boot(js, opts, evalDir) {
  const e = await require(path.join(dir, js + '.js'))({ wasmBinary: fs.readFileSync(path.join(dir, js + '.wasm')), locateFile: (f) => path.join(dir, f) });
  if (evalDir) { e.FS.mkdir('/eval'); for (const f of ['nn.bin', 'progress.bin', 'eval_options.txt']) e.FS.writeFile(`/eval/${f}`, fs.readFileSync(path.join(evalDir, f))); }
  let w = null; const lines = [];
  e.addMessageListener((l) => { lines.push(l); if (w?.p(l)) { const x = w; w = null; x.r(lines.splice(0)); } });
  const ask = (c, p) => { lines.length = 0; return new Promise((r) => { w = { p, r }; e.postMessage(c); }); };
  await ask('usi', (l) => l === 'usiok');
  for (const [k, v] of opts) e.postMessage(`setoption name ${k} value ${v}`);
  await ask('isready', (l) => l === 'readyok');
  return { send: (c) => e.postMessage(c), ask };
}
const mini = await boot('yaneuraou.mini', [['Threads', '4'], ['USI_Hash', '16'], ['EvalDir', '/eval'], ['NetworkDelay', '0'], ['NetworkDelay2', '0'], ['MinimumThinkingTime', '100']], path.join(dir, 'eval/mini'));
const mate = await boot('yaneuraou.mate', [['Threads', '1'], ['USI_Hash', '64'], ['DepthLimit', '0'], ['PvInterval', '0']]);
const MB = () => mems.map((m) => (m.buffer.byteLength / 1048576).toFixed(0)).join(' / ') + 'MB';
const line = async (pos, cmd) => { mini.send(pos); const [l] = await mini.ask(cmd, () => true); return l.trim().split(/\s+/).filter(Boolean); };
const movetime = (rem) => (rem <= 4 ? 300 : rem <= 6 ? 500 : rem <= 8 ? 1000 : 1500);
let solves = 0, none = 0;
async function attackerMove(sfen, moves, rem) {
  const base = `position sfen ${sfen} moves ${moves.join(' ')}`;
  const legal = await line(base, 'moves'); if (!legal.length) return;
  const budget = movetime(rem); const t = performance.now();
  for (const r of legal) {
    const left = budget - (performance.now() - t); if (left <= 0) break;
    mate.send(`${base} ${r}`); const o = await mate.ask(`go mate ${Math.max(1, Math.round(left))}`, (l) => l.startsWith('checkmate')); solves++;
    if (o.at(-1).includes('none')) none++;
  }
  mini.send(base); await mini.ask(`go movetime ${Math.min(budget, 300)}`, (l) => l.startsWith('bestmove'));
}
const read = (book, vol) => fs.readFileSync(path.join(ROOT, '.cache/minimal-hand/public/data', book, `${vol}.txt`), 'utf8').split('\n').filter(Boolean);
const probs = [...read('mate11', '003').slice(0, N), ...read('mate9', '003').slice(0, N)];
console.log('起動後', MB(), 'mini / mate');
const t0 = Date.now();
for (const [i, r] of probs.entries()) {
  const [sfen, ms] = r.split(' moves '); const sol = ms.trim().split(/\s+/);
  for (let k = 0; k < sol.length; k += 2) await attackerMove(sfen, sol.slice(0, k + 1), sol.length - k - 1);
  const wrong = (await line(`position sfen ${sfen}`, 'checks')).find((m) => m !== sol[0]);
  if (wrong) await attackerMove(sfen, [wrong], sol.length - 1);
  if ((i + 1) % 50 === 0) console.log(`${i + 1}問`, MB(), `判定${solves}回 none${none}回`, `${Math.round((Date.now() - t0) / 1000)}s`, `JS heap ${Math.round(process.memoryUsage().heapUsed / 1048576)}MB`);
}
process.exit(0);
