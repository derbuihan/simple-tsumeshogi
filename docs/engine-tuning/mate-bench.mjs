// 詰み専用エンジン（WASM、public/engine）で「攻方が指した後の局面が N 手以内に詰むか」を判定する時間を測る。
// 玉方の合法手（mini エンジンの moves）ごとに、攻方の手番から go mate（DepthLimit = 残り手数 - 1、または上限なし）を調べ、
// すべての応手で詰めば詰み、1つでも詰まなければ不詰（そこで打ち切る）。
// mini-tune.mjs と同じ局面に加え、収録解の初手以外の王手（誤答）も調べる。
//
// 使い方（リポジトリ直下で。詰み専用エンジンを engine/build.sh mate でビルドしておく）:
//   node docs/engine-tuning/mate-bench.mjs "$PWD" <問題数> <出力.json> [USI_Hash(MB)=64] [手数の上限=limit|none|+N]
//   none: DepthLimit 0（上限なし）。+N: 残り手数 + N 手まで（遠回りの詰みも詰みとみなすときの判定）
setInterval(() => {}, 1000);
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const [ROOT, N, OUT, HASH = '64', DEPTH = 'limit'] = process.argv.slice(2);
const CAP = 6000;
const require = createRequire(import.meta.url);
async function boot(dir, js, wasm, evalDir) {
  const e = await require(path.join(dir, js))({ wasmBinary: fs.readFileSync(path.join(dir, wasm)), locateFile: (f) => path.join(dir, f) });
  if (evalDir) { e.FS.mkdir('/eval'); for (const f of ['nn.bin', 'progress.bin', 'eval_options.txt']) e.FS.writeFile(`/eval/${f}`, fs.readFileSync(path.join(evalDir, f))); }
  let waiter = null; const lines = [];
  e.addMessageListener((l) => { lines.push(l); if (waiter?.pred(l)) { const w = waiter; waiter = null; w.res(lines.splice(0)); } });
  const ask = (cmd, pred) => { lines.length = 0; const p = new Promise((res) => (waiter = { pred, res })); e.postMessage(cmd); return p; };
  await ask('usi', (l) => l === 'usiok');
  return { send: (c) => e.postMessage(c), ask };
}
const mini = await boot(path.join(ROOT, 'public/engine'), 'yaneuraou.mini.js', 'yaneuraou.mini.wasm', path.join(ROOT, 'public/engine/eval/mini'));
for (const c of ['Threads value 1', 'USI_Hash value 16', 'EvalDir value /eval']) mini.send(`setoption name ${c}`);
await mini.ask('isready', (l) => l === 'readyok');
const mate = await boot(path.join(ROOT, 'public/engine'), 'yaneuraou.mate.js', 'yaneuraou.mate.wasm');
for (const c of ['Threads value 1', `USI_Hash value ${HASH}`, 'PvInterval value 0']) mate.send(`setoption name ${c}`);
await mate.ask('isready', (l) => l === 'readyok');
const line = async (pos, cmd) => { mini.send(pos); const [l] = await mini.ask(cmd, () => true); return l.trim().split(/\s+/).filter(Boolean); };

/** moves（攻方が指した後まで）の局面が、remaining 手以内に詰むか */
async function judge(sfen, moves, remaining) {
  const base = `position sfen ${sfen} moves ${moves.join(' ')}`;
  const replies = await line(base, 'moves');
  const t = performance.now();
  if (replies.length === 0) return { mate: true, ms: 0, replies: 0 };
  const extra = DEPTH === 'limit' ? 0 : Number(DEPTH);
  mate.send(`setoption name DepthLimit value ${DEPTH === 'none' ? 0 : remaining - 1 + extra}`);
  for (const r of replies) {
    mate.send(`${base} ${r}`);
    const left = Math.max(1, CAP - (performance.now() - t));
    const o = await mate.ask(`go mate ${Math.round(left)}`, (l) => l.startsWith('checkmate'));
    const res = o.at(-1).split(' ')[1];
    if (res === 'nomate' || res === 'none' || res === 'timeout') return { mate: false, why: res, ms: Math.round(performance.now() - t), replies: replies.length };
  }
  return { mate: true, ms: Math.round(performance.now() - t), replies: replies.length };
}

const read = (book, vol) => fs.readFileSync(path.join(ROOT, '.cache/minimal-hand/public/data', book, `${vol}.txt`), 'utf8').split('\n').filter(Boolean);
const take = (book, n) => { const out = []; for (let v = 2; out.length < n; v++) out.push(...read(book, String(v).padStart(3, '0')).slice(0, 50)); return out.slice(0, n); };
const res = [];
const jobs = [...take('mate11', +N).map((r, i) => ({ id: `11-${i}`, r, ks: [1, 3] })), ...take('mate9', +N).map((r, i) => ({ id: `9-${i}`, r, ks: [1] }))];
for (const { id, r, ks } of jobs) {
  await mate.ask('isready', (l) => l === 'readyok');
  const [sfen, ms] = r.split(' moves '); const sol = ms.trim().split(/\s+/);
  for (const k of ks) {
    const j = await judge(sfen, sol.slice(0, k), sol.length - k);
    res.push({ id: `${id}/${k}`, rem: sol.length - k, ms: j.mate ? j.ms : null, why: j.why, replies: j.replies });
  }
  // 間違った王手（収録解の初手以外の最初の王手）
  const wrong = (await line(`position sfen ${sfen}`, 'checks')).find((m) => m !== sol[0]);
  if (wrong) { const j = await judge(sfen, [wrong], sol.length - 1); res.push({ id: `${id}/wrong`, rem: sol.length - 1, wrong: true, mate: j.mate, ms: j.ms, why: j.why }); }
}
fs.writeFileSync(OUT, JSON.stringify(res));
process.exit(0);
