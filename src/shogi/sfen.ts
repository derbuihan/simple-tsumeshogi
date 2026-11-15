import { emptyHand, HAND_TYPES, type Color, type HandType, type Piece, type PieceType, type Position } from './types';

const PIECE_TYPES = new Set<PieceType>(['P', 'L', 'N', 'S', 'G', 'B', 'R', 'K']);

/** SFEN（"<盤面> <手番> <持ち駒> [手数]"）を Position に変換する */
export function parseSfen(sfen: string): Position {
  const [boardPart, turnPart, handPart] = sfen.trim().split(/\s+/);
  if (!boardPart || (turnPart !== 'b' && turnPart !== 'w') || handPart === undefined) {
    throw new Error(`invalid sfen: ${sfen}`);
  }

  const board: (Piece | null)[] = [];
  const rows = boardPart.split('/');
  if (rows.length !== 9) throw new Error(`invalid sfen board: ${boardPart}`);
  for (const row of rows) {
    let promoted = false;
    let count = 0;
    for (const ch of row) {
      if (ch === '+') {
        promoted = true;
        continue;
      }
      if (/\d/.test(ch)) {
        for (let i = 0; i < Number(ch); i++) board.push(null);
        count += Number(ch);
        continue;
      }
      const type = ch.toUpperCase() as PieceType;
      if (!PIECE_TYPES.has(type)) throw new Error(`invalid sfen piece: ${ch}`);
      board.push({ color: ch === type ? 'b' : 'w', type, promoted });
      promoted = false;
      count++;
    }
    if (count !== 9) throw new Error(`invalid sfen row: ${row}`);
  }

  const hands = { b: emptyHand(), w: emptyHand() };
  if (handPart !== '-') {
    const re = /(\d*)([RBGSNLPrbgsnlp])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(handPart))) {
      const type = m[2].toUpperCase() as HandType;
      const color: Color = m[2] === type ? 'b' : 'w';
      hands[color][type] += m[1] ? Number(m[1]) : 1;
    }
  }

  return { board, hands, turn: turnPart };
}

/** 千日手判定用の局面キー（手数を含まない SFEN） */
export function positionKey(pos: Position): string {
  const rows: string[] = [];
  for (let r = 0; r < 9; r++) {
    let row = '';
    let empty = 0;
    for (let c = 0; c < 9; c++) {
      const p = pos.board[r * 9 + c];
      if (!p) {
        empty++;
        continue;
      }
      if (empty) row += empty;
      empty = 0;
      const ch = p.color === 'b' ? p.type : p.type.toLowerCase();
      row += (p.promoted ? '+' : '') + ch;
    }
    if (empty) row += empty;
    rows.push(row);
  }
  let hand = '';
  for (const color of ['b', 'w'] as const) {
    for (const t of HAND_TYPES) {
      const n = pos.hands[color][t];
      if (n) hand += (n > 1 ? n : '') + (color === 'b' ? t : t.toLowerCase());
    }
  }
  return `${rows.join('/')} ${pos.turn} ${hand || '-'}`;
}
