// 問題データを、起動中の cf dev（npm run dev）の Worker 経由でローカルの R2 に入れる。
// cf r2 objects put --local は1件ごとにプロセスを起動するので遅い。こちらは1プロセスから、複数ファイルをまとめて送る。
// 使い方: node scripts/upload-problems-local.mjs [mate3 mate5 ...]
// 環境変数: DEV_URL（既定 http://localhost:5173）, BATCH（1リクエストのファイル数、既定 50）, JOBS（並列数、既定 4）,
//           PROBLEMS_DIR（既定 .cache/minimal-hand/public/data）
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEV_URL = process.env.DEV_URL ?? 'http://localhost:5173';
const BATCH = Number(process.env.BATCH ?? 50);
const JOBS = Number(process.env.JOBS ?? 4);
const DIR = process.env.PROBLEMS_DIR ?? path.join(ROOT, '.cache/minimal-hand/public/data');
const books = process.argv.length > 2 ? process.argv.slice(2) : ['mate3', 'mate5', 'mate7', 'mate9', 'mate11'];

if (!fs.existsSync(path.join(DIR, books[0]))) {
  console.error(`問題データがありません: ${DIR}`);
  process.exit(1);
}
const keys = books.flatMap((b) =>
  fs
    .readdirSync(path.join(DIR, b))
    .filter((f) => /^\d{3}\.txt$/.test(f))
    .sort()
    .map((f) => `${b}/${f}`),
);

async function post(batch) {
  const body = JSON.stringify(Object.fromEntries(batch.map((k) => [k, fs.readFileSync(path.join(DIR, k), 'utf8')])));
  const res = await fetch(`${DEV_URL}/__dev/problems`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  if (res.status !== 204) throw new Error(`${res.status} ${await res.text()}`);
}

const batches = [];
for (let i = 0; i < keys.length; i += BATCH) batches.push(keys.slice(i, i + BATCH));

// 先に1件送って、cf dev が起動しているか・投入口があるかを確かめる
try {
  await post([keys[0]]);
} catch (e) {
  console.error(`${DEV_URL} に送れません。先に npm run dev を起動してください（${e.cause?.code ?? e.message}）`);
  process.exit(1);
}

const started = Date.now();
let next = 0;
let done = 0;
const failed = [];
await Promise.all(
  Array.from({ length: JOBS }, async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      try {
        await post(batch);
        done += batch.length;
      } catch (e) {
        failed.push(`${batch[0]}..${batch.at(-1)}: ${e.message}`);
      }
      if (Math.floor(done / 1000) !== Math.floor((done - batch.length) / 1000)) console.log(`${done}/${keys.length}`);
    }
  }),
);
console.log(`uploaded ${done}/${keys.length} files to local R2 in ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (failed.length) {
  console.error(`failed batches (rerun to retry):\n${failed.join('\n')}`);
  process.exit(1);
}
