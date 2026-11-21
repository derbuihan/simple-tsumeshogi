import { fragment } from '../pieceDom';
import type { AnimationScope } from './animationScope';
import { ripple, type BoardFx } from './pieceEffects';

/**
 * 詰み。最後の手の着地で一瞬止め（ヒットストップ）、玉を沈ませて玉のマスを赤く灯し、
 * 玉から波紋を広げてから「詰」の印を押す。onHit は玉が沈む瞬間（音を合わせる）。
 * rare（珍しい達成）のときは印と波紋を金色にする。
 * scope は最後の手と同じもの（ヒットストップでその着地の演出を止める）。カードを出してよくなったら、または cancel されたら解決する。
 */
export async function playMate(scope: AnimationScope, fx: BoardFx, king: HTMLElement, rare: boolean, onHit: () => void): Promise<void> {
  // ヒットストップ：着地の演出を潰れた瞬間で止める
  scope.pause();
  const held = await scope.wait(110);
  scope.resume();
  if (!held) return;

  onHit();
  void scope.animate(
    king.querySelector<HTMLElement>('.pc-face')!,
    [
      { transform: 'translate(0, 0) scale(1)' },
      { transform: 'translate(-2px, 1px) scale(0.95)', offset: 0.12 },
      { transform: 'translate(2px, 2px) scale(0.93)', offset: 0.26 },
      { transform: 'translate(-1.5px, 2px) scale(0.93)', offset: 0.4 },
      { transform: 'translate(1px, 2px) scale(0.94)', offset: 0.55 },
      { transform: 'translate(0, 2px) scale(0.94)' },
    ],
    { duration: 380, easing: 'ease-out', fill: 'forwards' },
  );
  const glow = scope.track(
    fragment(`<div class="impact-fx" style="${king.getAttribute('style')}"><div class="mate-glow"></div><div class="impact-ring mate-ring"></div></div>`),
  );
  fx.pieces.insertBefore(glow, king);
  const [g, ring] = [...glow.children];
  void scope.animate(g, [{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0.7 }], { duration: 500, easing: 'ease-out', fill: 'forwards' });
  void scope.animate(
    ring,
    [
      { transform: 'scale(0.9)', opacity: 1 },
      { transform: 'scale(3)', opacity: 0 },
    ],
    { duration: 480, easing: 'cubic-bezier(.1,.8,.3,1)' },
  );
  ripple(scope, fx, king, rare ? 'mate rare' : 'mate', 620);

  if (!(await scope.wait(220))) return;
  const stamp = scope.track(fragment(`<div class="mate-stamp${rare ? ' rare' : ''}" aria-hidden="true"><span>詰</span></div>`));
  fx.pieces.appendChild(stamp);
  void scope
    .animate(
      stamp,
      [
        { transform: 'translate(-50%, -50%) rotate(-12deg) scale(2.4)', opacity: 0 },
        { transform: 'translate(-50%, -50%) rotate(-8deg) scale(0.94)', opacity: 1, offset: 0.12 },
        { transform: 'translate(-50%, -50%) rotate(-8deg) scale(1)', opacity: 1, offset: 0.2 },
        { transform: 'translate(-50%, -50%) rotate(-8deg) scale(1)', opacity: 1, offset: 0.7 },
        { transform: 'translate(-50%, -50%) rotate(-8deg) scale(1)', opacity: 0 },
      ],
      { duration: 1600, easing: 'cubic-bezier(.3,.7,.3,1)' },
    )
    .then(() => stamp.remove());
  // 印が押されてから少し見せる
  await scope.wait(330);
}
