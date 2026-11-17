import './styles.css';
import { App } from './app';
import { HistoryStore } from './history/store';
import { loadSettings } from './settings';

// index.html の見張りに、アプリの JS が動き出したことを知らせる
(window as unknown as { __started: boolean }).__started = true;

const root = document.querySelector<HTMLDivElement>('#app')!;
const app = new App(root, loadSettings(), new HistoryStore());
const started = app.start();

// ホーム画面に追加したアプリの起動を速くする（開発中は Vite の HMR と競合するので本番だけ）
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js'));
  // 起動が済んだら、それまでに読み込んだもの（エンジン・問題など）をキャッシュに入れてもらう。
  // 初回は Service Worker が動き出す前に読み込みが終わっていて、そのままではキャッシュに残らないため
  void Promise.all([started, navigator.serviceWorker.ready]).then(([, reg]) => {
    const urls = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .filter((u) => u.startsWith(location.origin));
    reg.active?.postMessage({ type: 'cache-urls', urls });
  });
}

// 開発時のみ: ブラウザからの動作確認用
if (import.meta.env.DEV) (window as unknown as { __app: App }).__app = app;
