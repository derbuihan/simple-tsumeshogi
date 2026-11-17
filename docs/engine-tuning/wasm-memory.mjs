// エンジンを1つ、アプリと同じ設定で起動し、WASM のメモリ（WebAssembly.Memory の大きさ）がどの時点で増えるかを見る。
// 使い方（リポジトリ直下で）: node docs/engine-tuning/wasm-memory.mjs "$PWD" <mini|mate>
setInterval(() => {}, 1000);
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const ROOT = process.argv[2]; const which = process.argv[3];
const mems = []; const Orig = WebAssembly.Memory;
WebAssembly.Memory = function (d) { const m = new Orig(d); mems.push(m); return m; }; WebAssembly.Memory.prototype = Orig.prototype;
const require = createRequire(import.meta.url); const dir = path.join(ROOT, 'public/engine');
const js = which === 'mate' ? 'yaneuraou.mate' : 'yaneuraou.mini';
const e = await require(path.join(dir, js + '.js'))({ wasmBinary: fs.readFileSync(path.join(dir, js + '.wasm')), locateFile: (f) => path.join(dir, f) });
const MB = () => mems.map((m) => (m.buffer.byteLength / 1048576).toFixed(0) + 'MB').join(',');
console.log(which, '読み込み直後', MB());
if (which !== 'mate') { e.FS.mkdir('/eval'); for (const f of ['nn.bin', 'progress.bin', 'eval_options.txt']) e.FS.writeFile(`/eval/${f}`, fs.readFileSync(path.join(dir, 'eval/mini', f))); console.log(which, '評価関数を置いた後', MB()); }
let w = null; e.addMessageListener((l) => { if (w?.p(l)) { const x = w; w = null; x.r(); } });
const ask = (c, p) => new Promise((r) => { w = { p, r }; e.postMessage(c); });
await ask('usi', (l) => l === 'usiok');
const opts = which === 'mate'
  ? [['Threads', '1'], ['USI_Hash', '64'], ['DepthLimit', '0'], ['PvInterval', '0']]
  : [['Threads', '4'], ['USI_Hash', '16'], ['EvalDir', '/eval'], ['NetworkDelay', '0'], ['NetworkDelay2', '0'], ['MinimumThinkingTime', '100']];
for (const [k, v] of opts) e.postMessage(`setoption name ${k} value ${v}`);
await ask('isready', (l) => l === 'readyok');
console.log(which, 'isready 後', MB());
e.postMessage('position startpos');
if (which === 'mate') { e.postMessage('position sfen 7nl/7k1/9/7P1/9/9/9/9/9 b G 1'); await ask('go mate 1000', (l) => l.startsWith('checkmate')); }
else await ask('go movetime 500', (l) => l.startsWith('bestmove'));
console.log(which, '探索1回の後', MB());
process.exit(0);
