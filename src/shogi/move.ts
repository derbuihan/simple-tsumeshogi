import { opposite, squareIndex, type HandType, type Position } from './types';

/** USI の指し手（例: "7g7f", "8h2b+", "B*5e"）を分解したもの */
export type UsiMove =
  | { kind: 'move'; from: number; to: number; promote: boolean }
  | { kind: 'drop'; type: HandType; to: number };

const parseSquare = (s: string): number => {
  const file = Number(s[0]);
  const rank = s.charCodeAt(1) - 'a'.charCodeAt(0);
  if (!(file >= 1 && file <= 9 && rank >= 0 && rank <= 8)) throw new Error(`invalid square: ${s}`);
  return squareIndex(file, rank);
};

export function parseUsiMove(usi: string): UsiMove {
  if (usi[1] === '*') {
    return { kind: 'drop', type: usi[0].toUpperCase() as HandType, to: parseSquare(usi.slice(2, 4)) };
  }
  return { kind: 'move', from: parseSquare(usi.slice(0, 2)), to: parseSquare(usi.slice(2, 4)), promote: usi[4] === '+' };
}

/** 指し手を適用した新しい局面を返す（合法性はエンジン側で保証されている前提で検査しない） */
export function applyMove(pos: Position, usi: string): Position {
  const m = parseUsiMove(usi);
  const board = pos.board.slice();
  const hands = { b: { ...pos.hands.b }, w: { ...pos.hands.w } };
  const me = pos.turn;

  if (m.kind === 'drop') {
    if (hands[me][m.type] <= 0) throw new Error(`no piece in hand: ${usi}`);
    if (board[m.to]) throw new Error(`drop to occupied square: ${usi}`);
    hands[me][m.type]--;
    board[m.to] = { color: me, type: m.type, promoted: false };
  } else {
    const piece = board[m.from];
    if (!piece || piece.color !== me) throw new Error(`no own piece at from: ${usi}`);
    const captured = board[m.to];
    if (captured) {
      if (captured.color === me) throw new Error(`capture own piece: ${usi}`);
      if (captured.type !== 'K') hands[me][captured.type as HandType]++;
    }
    board[m.from] = null;
    board[m.to] = { ...piece, promoted: piece.promoted || m.promote };
  }
  return { board, hands, turn: opposite(me) };
}

/** 指し手の列を順に適用する */
export function applyMoves(pos: Position, moves: readonly string[]): Position {
  return moves.reduce(applyMove, pos);
}
