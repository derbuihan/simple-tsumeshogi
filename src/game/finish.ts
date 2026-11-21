import { applyMove, parseUsiMove } from '../shogi/move';
import { opposite, type Piece, type PieceType, type Position } from '../shogi/types';

/**
 * 詰め方。詰ませた手順と局面だけから言える事実（エンジンは使わない）。詰みの演出を変えるのに使う。
 */
export interface Finish {
  /** 最後の手で成った（成って詰み） */
  promote: boolean;
  /** 頭金：最後の手が、玉の真正面（攻方の側）のマスへの金（打つ・動かすのどちらでも。成金は含めない） */
  headGold: boolean;
  /** 捨て駒：玉方に取らせた攻方の駒の種類（取られた順。成駒は元の種類） */
  sacrifices: PieceType[];
  /** 合駒を取った：玉方が合駒をしたマスのうち、直後に攻方がその駒を取ったマス */
  takenInterpositions: number[];
  /** 最後に動かした（打った）駒。成ったならその姿 */
  lastPiece: Piece;
}

/**
 * start から moves（攻方の手から始まり、攻方の手で終わる）を指して詰ませたときの詰め方。
 * 攻方は start の手番の側。玉方は毎手王手をかけられているので、玉方が駒を打つ手と、
 * 玉以外の駒を空きマスへ動かす手は合駒とみなす。
 */
export function finishOf(start: Position, moves: readonly string[]): Finish {
  if (moves.length === 0) throw new Error('no moves');
  const attacker = start.turn;
  const defender = opposite(attacker);
  const sacrifices: PieceType[] = [];
  const takenInterpositions: number[] = [];
  let pos = start;
  let interposedAt = -1;
  for (const [i, usi] of moves.entries()) {
    const m = parseUsiMove(usi);
    if (i % 2 === 1) {
      // 玉方の手
      interposedAt = -1;
      if (m.kind === 'drop') {
        interposedAt = m.to;
      } else {
        const taken = pos.board[m.to];
        if (taken && taken.color === attacker) sacrifices.push(taken.type);
        else if (!taken && pos.board[m.from]?.type !== 'K') interposedAt = m.to;
      }
    } else if (interposedAt >= 0) {
      // 攻方の手：直前の合駒を取ったか
      if (m.kind === 'move' && m.to === interposedAt) takenInterpositions.push(m.to);
      interposedAt = -1;
    }
    pos = applyMove(pos, usi);
  }
  const last = parseUsiMove(moves[moves.length - 1]);
  const lastPiece = pos.board[last.to]!;
  const king = pos.board.findIndex((p) => p?.type === 'K' && p.color === defender);
  // 玉の真正面＝攻方の側に1段。後手の玉なら段が増える向き、先手の玉なら減る向き
  const head = king < 0 ? -1 : defender === 'w' ? king + 9 : king - 9;
  return {
    promote: last.kind === 'move' && last.promote,
    headGold: head >= 0 && head < 81 && last.to === head && lastPiece.type === 'G' && lastPiece.color === attacker,
    sacrifices,
    takenInterpositions,
    lastPiece,
  };
}
