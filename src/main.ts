import './styles.css';
import { App } from './app';

const root = document.querySelector<HTMLDivElement>('#app')!;
// Phase 3 で設定画面と保存に置き換える（初期値: 3・5・7手詰、手数非表示、11mini）
const app = new App(root, { lengths: [3, 5, 7], showLength: false, variant: 'mini' });
void app.start();

// 開発時のみ: ブラウザからの動作確認用
if (import.meta.env.DEV) (window as unknown as { __app: App }).__app = app;
