import { applyMove, parseUsiMove, type UsiMove } from '../shogi/move';
import { positionKey } from '../shogi/sfen';
import type { Color, Piece, Position } from '../shogi/types';

/** 直前の局面から1手進んだときの、アニメーションに必要な情報 */
export interface Step {
  move: UsiMove;
  /** 指した側 */
  mover: Color;
  /** 動かした駒（指す前の状態。駒打ちなら打った駒） */
  piece: Piece;
  /** 取った駒（取っていなければ null） */
  captured: Piece | null;
}

/**
 * prev に usi を指すとちょうど next になるなら、その1手の情報を返す。
 * やり直し・別の問題・解答再生での巻き戻しなど、1手進んだのでなければ null（アニメーションしない）。
 */
export function detectStep(prev: Position, next: Position, usi: string | null): Step | null {
  if (!usi) return null;
  let moved: Position;
  try {
    moved = applyMove(prev, usi);
  } catch {
    return null;
  }
  if (positionKey(moved) !== positionKey(next)) return null;
  const move = parseUsiMove(usi);
  const mover = prev.turn;
  if (move.kind === 'drop') return { move, mover, piece: { color: mover, type: move.type, promoted: false }, captured: null };
  return { move, mover, piece: prev.board[move.from]!, captured: prev.board[move.to] };
}
