// mate-bench.mjs の「間違った王手」（収録解の初手以外の最初の王手）の後の局面を、mini で探索する。
// 今のアプリと同じ判定（score mate が出れば詰み）で、詰み専用エンジンの判定と見比べるためのもの。
// 問題ごとに isready で置換表を空にする。6秒（CAP）以内に score mate が出なければ ms: null。
//
// 使い方（リポジトリ直下で）:
//   node docs/engine-tuning/mini-wrong.mjs "$PWD" <Threads> <問題数> <出力.json> [分割数=1] [何番目か=0]
//   分割すると、問題を順に振り分けてその分だけ調べる（並列に回して、出力をあとでつなぐ）
setInterval(() => {}, 1000);
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const [ROOT, TH, N, OUT, SHARDS = '1', SHARD = '0'] = process.argv.slice(2);
const CAP = 6000;
const require = createRequire(import.meta.url);
const dir = path.join(ROOT, 'public/engine');
const engine = await require(path.join(dir, 'yaneuraou.mini.js'))({ wasmBinary: fs.readFileSync(path.join(dir, 'yaneuraou.mini.wasm')), locateFile: (f) => path.join(dir, f) });
engine.FS.mkdir('/eval');
for (const f of ['nn.bin', 'progress.bin', 'eval_options.txt']) engine.FS.writeFile(`/eval/${f}`, fs.readFileSync(path.join(dir, 'eval/mini', f)));
let waiter = null; const lines = [];
engine.addMessageListener((l) => { lines.push(l); if (waiter?.pred(l)) { const w = waiter; waiter = null; w.res(lines.splice(0)); } });
const send = (c) => engine.postMessage(c);
const ask = (cmd, pred) => { lines.length = 0; const p = new Promise((res) => (waiter = { pred, res })); send(cmd); return p; };
await ask('usi', (l) => l === 'usiok');
for (const c of [`Threads value ${TH}`, 'USI_Hash value 16', 'EvalDir value /eval', 'NetworkDelay value 0', 'NetworkDelay2 value 0', 'MinimumThinkingTime value 100']) send(`setoption name ${c}`);
await ask('isready', (l) => l === 'readyok');
const read = (book, vol) => fs.readFileSync(path.join(ROOT, '.cache/minimal-hand/public/data', book, `${vol}.txt`), 'utf8').split('\n').filter(Boolean);
const take = (book, n) => { const out = []; for (let v = 2; out.length < n; v++) out.push(...read(book, String(v).padStart(3, '0')).slice(0, 50)); return out.slice(0, n); };
const res = [];
const jobs = [...take('mate11', +N).map((r, i) => ({ id: `11-${i}`, r })), ...take('mate9', +N).map((r, i) => ({ id: `9-${i}`, r }))];
for (const { id, r } of jobs.filter((_, i) => i % +SHARDS === +SHARD)) {
  await ask('isready', (l) => l === 'readyok');
  const [sfen, ms] = r.split(' moves '); const sol = ms.trim().split(/\s+/);
  send(`position sfen ${sfen}`);
  const [cl] = await ask('checks', () => true);
  const wrong = cl.trim().split(/\s+/).filter(Boolean).find((m) => m !== sol[0]);
  if (!wrong) continue;
  send(`position sfen ${sfen} moves ${wrong}`);
  const [ml] = await ask('moves', () => true);
  if (!ml.trim()) { res.push({ id: `${id}/wrong`, ms: 0, mateIn: 0 }); continue; }
  const t = performance.now();
  const o = await ask(`go movetime ${CAP}`, (l) => l.startsWith('bestmove'));
  const dt = performance.now() - t;
  const m = o.map((l) => l.match(/ score mate -(\d+)/)).filter(Boolean).at(-1);
  res.push({ id: `${id}/wrong`, ms: m ? Math.round(dt) : null, mateIn: m ? +m[1] : null });
}
fs.writeFileSync(OUT, JSON.stringify(res));
process.exit(0);
