import { pieceChar } from '../shogi/notation';
import type { Piece } from '../shogi/types';

/** 駒の要素。upright = 手前向き（攻方の駒・攻方の駒台） */
export function pieceHtml(p: Piece, upright: boolean, attrs = ''): string {
  const cls = `pc t-${p.type}${p.promoted ? ' promoted' : ''}${upright ? '' : ' flip'}`;
  return `<div class="${cls}"${attrs}><div class="pc-face"><div class="pc-body"><span class="pc-char">${pieceChar(p)}</span></div></div></div>`;
}

/** 駒の文字と成りの表示を差し替える */
export function setFace(el: HTMLElement, p: Piece): void {
  el.querySelector('.pc-char')!.textContent = pieceChar(p);
  el.classList.toggle('promoted', p.promoted);
}

export function fragment(html: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content.firstElementChild as HTMLElement;
}
