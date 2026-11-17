// 設定（Threads / USI_Hash）ごとに、深い局面で詰みを見つけるまでの時間を測る。
// 問題ごとに isready で置換表を空にし（順番の影響をなくす）、問題の中では続けて探索する（アプリと同じ）。
// 対象: mate11 の玉方1手目（残り10手）と3手目（残り8手）、mate9 の玉方1手目（残り8手）。各手数とも 002 巻から1巻50問ずつ。
// 6秒（CAP）以内に score mate が出なければ「未発見」（ms: null）。
//
// 使い方（リポジトリ直下で。問題データは .cache/minimal-hand/public/data に置いておく）:
//   node docs/engine-tuning/mini-tune.mjs "$PWD" <Threads> <USI_Hash(MB)> <問題数> <出力.json>
//   例: node docs/engine-tuning/mini-tune.mjs "$PWD" 4 16 200 /tmp/mini_t4_h16.json
setInterval(() => {}, 1000);
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const [ROOT, TH, HASH, N, OUT] = process.argv.slice(2);
const CAP = 6000;
const require = createRequire(import.meta.url);
const dir = path.join(ROOT, 'public/engine');
const engine = await require(path.join(dir, 'yaneuraou.mini.js'))({ wasmBinary: fs.readFileSync(path.join(dir, 'yaneuraou.mini.wasm')), locateFile: (f) => path.join(dir, f) });
engine.FS.mkdir('/eval');
for (const f of ['nn.bin', 'progress.bin', 'eval_options.txt']) engine.FS.writeFile(`/eval/${f}`, fs.readFileSync(path.join(dir, 'eval/mini', f)));
let waiter = null; const lines = [];
engine.addMessageListener((l) => { lines.push(l); if (waiter?.pred(l)) { const w = waiter; waiter = null; w.res(lines.splice(0)); } });
const until = (pred) => new Promise((res) => (waiter = { pred, res }));
const send = (c) => engine.postMessage(c);
const ask = async (cmd, pred) => { lines.length = 0; const w = until(pred); send(cmd); return w; };
await ask('usi', (l) => l === 'usiok');
for (const c of [`Threads value ${TH}`, `USI_Hash value ${HASH}`, 'EvalDir value /eval', 'NetworkDelay value 0', 'NetworkDelay2 value 0', 'MinimumThinkingTime value 100']) send(`setoption name ${c}`);
await ask('isready', (l) => l === 'readyok');
const read = (book, vol) => fs.readFileSync(path.join(ROOT, '.cache/minimal-hand/public/data', book, `${vol}.txt`), 'utf8').split('\n').filter(Boolean);
const take = (book, n) => { const out = []; for (let v = 2; out.length < n; v++) out.push(...read(book, String(v).padStart(3, '0')).slice(0, 50)); return out.slice(0, n); };
const res = [];
const jobs = [...take('mate11', +N).map((r, i) => ({ id: `11-${i}`, r, ks: [1, 3] })), ...take('mate9', +N).map((r, i) => ({ id: `9-${i}`, r, ks: [1] }))];
for (const { id, r, ks } of jobs) {
  await ask('isready', (l) => l === 'readyok');
  const [sfen, ms] = r.split(' moves '); const sol = ms.trim().split(/\s+/);
  for (const k of ks) {
    send(`position sfen ${sfen} moves ${sol.slice(0, k).join(' ')}`);
    const t = performance.now();
    const o = await ask(`go movetime ${CAP}`, (l) => l.startsWith('bestmove'));
    const dt = performance.now() - t;
    res.push({ id: `${id}/${k}`, rem: sol.length - k, ms: o.some((l) => / score mate -/.test(l)) ? Math.round(dt) : null });
  }
}
fs.writeFileSync(OUT, JSON.stringify(res));
process.exit(0);
