// やねうら王WASM（USI拡張 checks 付き）を Node 上で起動し、詰将棋判定に必要な動作を検証する。
// 使い方: node scripts/engine-smoke.mjs [mini|micro] [問題数/手数=3] [movetime_ms=2000]
//
// 検証内容（各問題）:
//   1. checks に収録解の初手が含まれる
//   2. 収録解どおり進める途中、玉方の手番で moves が空でなく、探索結果が score mate (玉方視点で負) になる
//   3. 収録解の最終局面で moves が空（＝詰み）
//   4. 参考: 収録解の初手以外の王手を指したときの玉方探索結果
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const variant = process.argv[2] ?? 'mini';
const perBook = Number(process.argv[3] ?? 3);
const movetime = Number(process.argv[4] ?? 2000);

const require = createRequire(import.meta.url);
const engineDir = path.join(ROOT, 'public/engine');
const factory = require(path.join(engineDir, `yaneuraou.${variant}.js`));
const wasmBinary = fs.readFileSync(path.join(engineDir, `yaneuraou.${variant}.wasm`));

const engine = await factory({ wasmBinary, locateFile: (f) => path.join(engineDir, f) });

// eval ファイルを仮想FSへ
const evalSrc = path.join(engineDir, 'eval', variant);
engine.FS.mkdir('/eval');
for (const f of ['nn.bin', 'progress.bin', 'eval_options.txt']) {
  engine.FS.writeFile(`/eval/${f}`, fs.readFileSync(path.join(evalSrc, f)));
}

// ---- USI 通信ヘルパ ----
const lines = [];
let waiter = null;
engine.addMessageListener((line) => {
  if (process.env.USI_DEBUG) console.log('<', line);
  lines.push(line);
  if (waiter && waiter.pred(line)) {
    const w = waiter;
    waiter = null;
    w.resolve(lines.splice(0));
  }
});
function send(cmd) {
  if (process.env.USI_DEBUG) console.log('>', cmd);
  engine.postMessage(cmd);
}
function until(pred, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting engine')), timeoutMs);
    waiter = { pred, resolve: (v) => { clearTimeout(t); resolve(v); } };
  });
}
// 探索中でなければ、moves / checks の応答は直後の1行（合法手がなければ空行）。
// ⚠ isready は局面を初期化するので区切りには使わない。
async function query(position, cmd) {
  send(position);
  lines.length = 0;
  const p = until(() => true);
  send(cmd);
  const [line] = await p;
  return line.trim().split(/\s+/).filter(Boolean);
}
async function search(position) {
  send(position);
  lines.length = 0;
  send(`go movetime ${movetime}`);
  const out = await until((l) => l.startsWith('bestmove'));
  let score = null;
  for (const l of out) {
    const m = l.match(/score (cp|mate) (\S+)/);
    if (m) score = { kind: m[1], value: m[2] };
  }
  const bestmove = out.at(-1).split(/\s+/)[1];
  return { score, bestmove };
}

// ---- 初期化 ----
const t0 = Date.now();
send('usi');
await until((l) => l === 'usiok');
send('setoption name Threads value 1');
send('setoption name USI_Hash value 16');
send('setoption name EvalDir value /eval');
send('setoption name NetworkDelay value 0');
send('setoption name NetworkDelay2 value 0');
send('setoption name MinimumThinkingTime value 100');
send('isready');
await until((l) => l === 'readyok', 120000);
console.log(`engine ready (${variant}) in ${Date.now() - t0} ms`);

// 評価関数が読めているかの簡易確認
console.log('eval(startpos):', (await (async () => {
  send('position startpos');
  lines.length = 0;
  send('e');
  send('isready');
  const out = await until((l) => l === 'readyok');
  return out.filter((l) => l !== 'readyok').join(' | ');
})()));

// ---- 問題で検証 ----
const failures = [];
const isMateForDefender = (s) => s && s.kind === 'mate' && s.value.startsWith('-');

for (const book of ['mate3', 'mate5', 'mate7', 'mate9', 'mate11']) {
  const text = fs.readFileSync(path.join(ROOT, '.cache/shogimate/public/data', book, '000.txt'), 'utf8');
  const records = text.split('\n').filter((l) => l.trim()).slice(0, perBook);
  for (const [i, rec] of records.entries()) {
    const [sfen, movesStr] = rec.split(' moves ');
    const sol = movesStr.trim().split(/\s+/);
    const id = `${book}/000/${i}`;
    const tStart = Date.now();
    const log = [];

    const checks = await query(`position sfen ${sfen}`, 'checks');
    if (!checks.includes(sol[0])) failures.push(`${id}: checks に初手 ${sol[0]} がない [${checks.join(' ')}]`);
    log.push(`checks=${checks.length}`);

    for (let ply = 1; ply <= sol.length; ply++) {
      const pos = `position sfen ${sfen} moves ${sol.slice(0, ply).join(' ')}`;
      if (ply % 2 === 1) {
        // 攻方が指した直後 → 玉方の手番
        const legal = await query(pos, 'moves');
        if (ply === sol.length) {
          if (legal.length !== 0) failures.push(`${id}: 最終局面で玉方に合法手がある [${legal.join(' ')}]`);
        } else {
          const r = await search(pos);
          log.push(`ply${ply}:${r.score?.kind}${r.score?.value}`);
          if (!isMateForDefender(r.score)) failures.push(`${id}: ply${ply} で詰みを検出できない (${JSON.stringify(r.score)})`);
        }
      }
    }

    // 参考: 初手以外の王手を指した場合
    const alt = checks.find((m) => m !== sol[0]);
    if (alt) {
      const pos = `position sfen ${sfen} moves ${alt}`;
      const legal = await query(pos, 'moves');
      const r = legal.length ? await search(pos) : { score: { kind: 'mated', value: '' } };
      log.push(`alt ${alt}:${r.score?.kind}${r.score?.value}`);
    }
    console.log(`${id} sol=${sol.length} ${log.join(' ')} (${Date.now() - tStart} ms)`);
  }
}

console.log(failures.length ? `\nFAILURES (${failures.length}):\n${failures.join('\n')}` : '\nALL OK');
engine.terminate();
process.exit(failures.length ? 1 : 0);
