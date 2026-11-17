// Service Worker。ホーム画面に追加したアプリの2回目以降の起動を速くする（エンジン約7MBを毎回取りに行かない）。
//
// キャッシュの方針（同じオリジンの GET だけを扱う。/api/* と /__dev/* は素通しする）
//   ページ（/）                : キャッシュがあればすぐ返し、裏で新しい版を取り直す。起動画面を短くし、電波がなくても起動できる。
//                                新しい版は、それが指す JS・CSS をキャッシュに入れ終えてから差し替える（updatePage）。
//                                そのため更新が見えるのは、デプロイ後の次の次の起動から
//   /assets/*（名前にハッシュ）: キャッシュ優先（中身が変われば名前が変わる）
//   /engine/*（約7MB × 2種）   : キャッシュ優先。エンジンや評価関数を入れ替えたら ENGINE_CACHE の版を上げる
//   /problems/*（問題データ）  : キャッシュ優先（問題は書き換えない）
//   それ以外（索引・アイコン等）: キャッシュがあればすぐ返し、裏でネットから取り直す（stale-while-revalidate）
//
// ⚠ ページをキャッシュから返すと、headless Chrome では2回目以降の起動が真っ白になることがあった（実機では未確認）。
//   キャッシュのページでアプリが起動しなければ、index.html の見張りがキャッシュのページを消して読み込み直す。
//
// ⚠ 応答の本体は必ず最後まで読まれるようにする（clone した片方を読まずに捨てない）。

const APP_CACHE = 'app-v1';
const ENGINE_CACHE = 'engine-v1';
const PROBLEM_CACHE = 'problems-v1';
const CACHES = [APP_CACHE, ENGINE_CACHE, PROBLEM_CACHE];
/** キャッシュするページ（start_url）。index.html の見張りもこのキーを消す */
const PAGE = '/';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(['/manifest.webmanifest'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !CACHES.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** パスごとのキャッシュ先と取り方。null ならキャッシュしない */
function routeFor(path) {
  if (path.startsWith('/api/') || path.startsWith('/__dev/')) return null;
  if (path.startsWith('/assets/')) return { cache: APP_CACHE, cacheFirst: true };
  if (path.startsWith('/engine/')) return { cache: ENGINE_CACHE, cacheFirst: true };
  if (path.startsWith('/problems/')) return { cache: PROBLEM_CACHE, cacheFirst: true };
  return { cache: APP_CACHE, cacheFirst: false };
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    if (url.pathname === PAGE) servePage(event);
    return;
  }
  const route = routeFor(url.pathname);
  if (!route) return;
  // 応答を返した後もキャッシュへの書き込みや取り直しが終わるまで Service Worker を止めさせない。
  // waitUntil は respondWith の Promise が決着する前に呼ぶ必要がある
  const keepAlive = (p) => event.waitUntil(p.catch(() => undefined));
  const save = (key, res) => keepAlive(store(route.cache, key, res));

  if (route.cacheFirst) event.respondWith(cacheFirst(req, route.cache, save));
  else event.respondWith(staleWhileRevalidate(req, route.cache, req, save, keepAlive));
});

// 初回の訪問では、この Service Worker が動き出す前にページがエンジンなどを読み込み終えている。
// ページから読み込み済みの URL の一覧を受け取り、まだキャッシュに無いものを入れておく（次の起動から使う）。
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'cache-urls') return;
  const jobs = [];
  for (const u of event.data.urls) {
    const url = new URL(u, self.location.origin);
    const route = url.origin === self.location.origin ? routeFor(url.pathname) : null;
    if (!route || url.pathname === PAGE) continue;
    const key = url.href;
    jobs.push(
      caches
        .open(route.cache)
        .then(async (c) => {
          if (await c.match(key)) return;
          const res = await fetch(url.href);
          if (res.ok) await c.put(key, res);
        })
        .catch(() => undefined),
    );
  }
  jobs.push(updatePage().catch(() => undefined));
  event.waitUntil(Promise.all(jobs));
});

/** ページ。キャッシュがあればすぐ返し、裏で取り直す。無ければ（初回）ブラウザに普通に読み込ませ、裏でキャッシュする */
function servePage(event) {
  event.waitUntil(updatePage().catch(() => undefined));
  event.respondWith(
    caches
      .open(APP_CACHE)
      .then((c) => c.match(PAGE))
      .then((hit) => hit ?? fetch(event.request)),
  );
}

/**
 * ネットから最新のページを取り、それが指す JS・CSS（/assets/*）をキャッシュに入れ終えてから、ページを差し替える。
 * 途中で失敗したら差し替えない（キャッシュのページが、キャッシュに無い JS・CSS を指すことが無いように）
 */
async function updatePage() {
  const res = await fetch(PAGE, { cache: 'no-cache' });
  if (!res.ok || res.redirected) return;
  const html = await res.text();
  const cache = await caches.open(APP_CACHE);
  for (const [, asset] of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
    if (await cache.match(asset)) continue;
    const r = await fetch(asset);
    if (!r.ok) return;
    await cache.put(asset, r);
  }
  // COOP/COEP などのヘッダーもそのまま残す（無いと SharedArrayBuffer が使えずエンジンが動かない）
  await cache.put(PAGE, new Response(html, { status: res.status, statusText: res.statusText, headers: res.headers }));
}

async function store(name, key, res) {
  try {
    await (await caches.open(name)).put(key, res);
  } catch {
    // 容量不足などでキャッシュできなくても、応答はもう返している
  }
}

async function cacheFirst(req, name, save) {
  const hit = await (await caches.open(name)).match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) save(req, res.clone());
  return res;
}

/** キャッシュがあればすぐ返し、裏でネットから取り直してキャッシュを更新する。無ければネットから取る */
async function staleWhileRevalidate(req, name, key, save, keepAlive) {
  const hit = await (await caches.open(name)).match(key);
  // 取り直した応答は、キャッシュが無ければ複製して片方をページへ、あればそのままキャッシュへ（どちらも本体を読み切る）
  const network = fetch(req).then((res) => {
    if (res.ok) save(key, hit ? res : res.clone());
    return res;
  });
  if (!hit) return network;
  keepAlive(network); // オフラインなら取り直せないだけ
  return hit;
}
