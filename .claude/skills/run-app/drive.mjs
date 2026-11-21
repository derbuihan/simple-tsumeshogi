// headless Chrome でアプリを開き、決めた問題の正解手順を指して、演出を計測する（Chrome DevTools Protocol を直接使う）。
//
// 使い方: node drive.mjs <full|cancel> <problemId> "<問題データの1行>"
//   full   : 正解手順を指して詰ませる → カードを閉じて振り返りで ←→ を連打する
//   cancel : 詰ませて、詰みの演出の途中（止めの直後）でカードを出して閉じ、振り返りで1手戻す
// 環境変数: URL（既定 http://localhost:5173/）, OUT（スクリーンショットの置き場所、既定 /tmp/tsume-drive）
// 結果は JSON で標準出力に出す。スクリーンショットは $OUT/<scenario>-*.png
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const [scenario, id, line] = process.argv.slice(2);
if (!['full', 'cancel'].includes(scenario) || !id || !line?.includes(' moves ')) {
  console.error('usage: node drive.mjs <full|cancel> <problemId> "<sfen> moves <手順>"');
  process.exit(2);
}
const URL = process.env.URL ?? 'http://localhost:5173/';
const OUT = process.env.OUT ?? '/tmp/tsume-drive';
mkdirSync(OUT, { recursive: true });
const port = 9300 + Math.floor(Math.random() * 500);
const profile = `${OUT}/profile-${port}`;
const chrome = spawn(
  'google-chrome',
  ['--headless=new', `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = () => {
  chrome.kill();
  setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
};

// ---- CDP ----
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try {
    target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
  } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pending = new Map();
const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
});
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++seq;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'));
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 860, deviceScaleFactor: 1, mobile: false });
// 読み込む前に：出す問題を決め打ちにし（tsume.upcoming.v1）、演出の計測を仕込む
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
  localStorage.setItem('tsume.settings.v1', JSON.stringify({ lengths: [Number(${JSON.stringify(id)}.match(/^mate(\\d+)/)[1])], order: 'untried', showLength: true, variant: 'mini', sound: true }));
  localStorage.setItem('tsume.upcoming.v1', ${JSON.stringify(JSON.stringify({ id, line }))});
  window.__log = []; window.__t0 = performance.now(); window.__all = [];
  const T = () => Math.round(performance.now() - window.__t0);
  // Animation.pause（ヒットストップ）と、作った Animation が終わったか
  const P = Animation.prototype.pause;
  Animation.prototype.pause = function () { window.__log.push([T(), 'pause']); return P.call(this); };
  const A = Element.prototype.animate;
  Element.prototype.animate = function (...a) {
    const an = A.apply(this, a);
    const rec = { cls: this.className, done: 'pending', an };
    an.finished.then(() => (rec.done = 'resolved'), () => (rec.done = 'rejected'));
    window.__all.push(rec);
    return an;
  };
  // 演出用の DOM（.pieces の駒以外の子）の出入りと、運んでいる駒（.moving）
  document.addEventListener('DOMContentLoaded', () => {
    const watch = () => {
      const pieces = document.querySelector('.pieces');
      if (!pieces) return setTimeout(watch, 50);
      const fxNode = (n) => n.nodeType === 1 && (!n.classList.contains('pc') || n.classList.contains('victim'));
      new MutationObserver((ms) => { for (const m of ms) {
        for (const n of m.addedNodes) if (fxNode(n)) window.__log.push([T(), '+', n.className]);
        for (const n of m.removedNodes) if (fxNode(n)) window.__log.push([T(), '-', n.className]);
      } }).observe(pieces, { childList: true });
      new MutationObserver((ms) => { for (const m of ms) if (m.target.classList?.contains('moving')) window.__log.push([T(), 'moving', m.target.dataset.index]); })
        .observe(pieces, { subtree: true, attributes: true, attributeFilter: ['class'] });
    };
    watch();
  });
`,
});
await send('Page.navigate', { url: URL });

// ページ内で使う関数。マスは USI（"7g"）→ 局面の index → 表示上の位置（攻方が後手なら反転）で探す
const helpers = `
  const flipped = () => document.querySelector('.hand-bottom .hand-label')?.textContent.startsWith('☖');
  const sq = (s) => (s.charCodeAt(1) - 97) * 9 + (9 - Number(s[0]));
  const display = (i) => (flipped() ? 80 - i : i);
  const cell = (i) => document.querySelector('.cell[data-display="' + display(i) + '"]');
  const until = async (f, ms = 30000) => { const t = performance.now(); while (!f()) { if (performance.now() - t > ms) throw new Error('timeout: ' + f); await new Promise((r) => setTimeout(r, 30)); } };
  const play = (u) => {
    if (u[1] === '*') {
      document.querySelector('.hand-bottom .hand-piece[data-type="' + u[0] + '"]').click();
    } else {
      cell(sq(u.slice(0, 2))).click();
    }
    cell(sq(u.slice(2, 4))).click();
    document.querySelector('[data-action="' + (u[4] === '+' ? 'promote-yes' : 'promote-no') + '"]')?.click();
  };
  const fxCount = () => document.querySelectorAll('.impact-fx, .board-ripple, .victim, .mate-stamp').length;
`;
const result = { scenario, id };
try {
  await ev(`(async () => { ${helpers} await until(() => document.querySelector('.board-area.interactive')); })()`);
  await sleep(1500); // エンジンの読み込み。間に合わなくても1手目は保留されるので、長く待たなくてよい
  const moves = line.split(' moves ')[1].trim().split(/\s+/);
  for (let i = 0; i < moves.length; i += 2) {
    const last = i === moves.length - 1;
    await ev(`(async () => { ${helpers}
      await until(() => document.querySelector('.board-area.interactive'));
      await new Promise((r) => setTimeout(r, 400));
      ${last ? 'window.__log = []; window.__t0 = performance.now();' : ''}
      play(${JSON.stringify(moves[i])});
    })()`);
    if (i === 0) {
      await sleep(25);
      await shot(`${scenario}-1-moving`);
    }
    // 玉方の応手が盤に出るまで待つ（直前の手の印がそのマスに付く）
    if (!last) await ev(`(async () => { ${helpers} await until(() => document.querySelector('.cell.last')?.dataset.display == display(sq(${JSON.stringify(moves[i + 1].slice(2, 4))}))); })()`);
  }

  if (scenario === 'full') {
    await sleep(480);
    await shot('full-2-mate-stamp');
    await ev(`(async () => { ${helpers} await until(() => !document.querySelector('.overlay').hidden); })()`);
    result.dialogAt = await ev('Math.round(performance.now() - window.__t0)');
    await sleep(400);
    await shot('full-3-dialog');
    result.log = (await ev('window.__log')).filter((e) => e[1] !== 'pause');
    result.pauses = (await ev('window.__log')).filter((e) => e[1] === 'pause').length;
    // 終わらないまま残っている Animation（あれば一時的な DOM が取り除かれない）
    // 幽霊（.haunt・.haunt-over）は結果のカードと並行して動き続けるので数えない
    result.unresolved = await ev(
      `window.__all.filter((r) => r.done === 'pending' && !r.an.effect?.target?.closest?.('.haunt, .haunt-over')).map((r) => r.cls + ' ' + r.an.playState + ' t=' + Math.round(r.an.currentTime) + ' pending=' + r.an.pending)`,
    );
    result.leftover = await ev(`[...document.querySelectorAll('.pieces > :not(.pc)')].map((n) => n.className)`);
    // カードを閉じて振り返り。←→ を連打する
    await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await sleep(200);
    result.mash = await ev(`(async () => { ${helpers}
      const key = (k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k }));
      for (const k of ['ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'ArrowRight']) { key(k); await new Promise((r) => setTimeout(r, 25)); }
      // 幽霊のふわふわ（CSS のアニメーション）と、照明の移り変わり（box-shadow の transition）は数えない
      const notGhost = (a) => !a.effect?.target?.closest?.('.haunt, .haunt-over') && !(a instanceof CSSTransition);
      const count = () => ({
        fx: fxCount(),
        frameAnims: document.querySelector('.board-frame').getAnimations().filter(notGhost).length,
        boardAnims: document.querySelector('.board-area').getAnimations({ subtree: true }).filter(notGhost).length,
        souls: document.querySelectorAll('.soul').length,
      });
      const right = count();
      await new Promise((r) => setTimeout(r, 1000));
      return { right, after1s: count() };
    })()`);
    await shot('full-4-after-mash');
  } else {
    await ev(`(async () => { ${helpers}
      await until(() => window.__log.some((e) => e[1] === 'pause'));
      await new Promise((r) => setTimeout(r, 130));
      window.__log.push([Math.round(performance.now() - window.__t0), 'CUT']);
      document.querySelector('.board-area').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await new Promise((r) => setTimeout(r, 20));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    })()`);
    await sleep(1500);
    result.log = (await ev('window.__log')).filter((e) => e[1] !== 'pause');
    result.after = await ev(`(() => { ${helpers} return { fx: fxCount(), overlayHidden: document.querySelector('.overlay').hidden, replay: document.querySelector('.board-area').classList.contains('replay') }; })()`);
    await shot('cancel-1-after');
  }
} catch (e) {
  result.failed = String(e);
  await shot(`${scenario}-failed`).catch(() => undefined);
}
result.errors = errors;
console.log(JSON.stringify(result, null, 1));
ws.close();
cleanup();
