import './styles.css';
import { App } from './app';
import { HistoryStore } from './history/store';
import { loadSettings } from './settings';

const root = document.querySelector<HTMLDivElement>('#app')!;
const app = new App(root, loadSettings(), new HistoryStore());
void app.start();

// 開発時のみ: ブラウザからの動作確認用
if (import.meta.env.DEV) (window as unknown as { __app: App }).__app = app;
