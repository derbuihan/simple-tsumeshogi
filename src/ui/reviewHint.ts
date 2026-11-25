// 振り返りの操作のヒント（「盤の左をタップで戻る・右で進む」）を、もう見せなくてよいかどうか。
// 一度でも盤のタップか左右キーで手を送ったら、操作は分かったとみなして、次からは出さない

const KEY = 'tsume.reviewHint.v1';

/** もう操作を覚えたか（ヒントを出さなくてよいか） */
export function loadReviewHintSeen(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** 操作を覚えたことを保存する。保存できなくても（容量・プライベートモード）この起動中は出さない */
export function saveReviewHintSeen(): void {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    // 保存できなくても続ける
  }
}
