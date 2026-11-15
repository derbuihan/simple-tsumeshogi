import { parseUsiMove } from './move';
import { indexToSquare, type Piece, type PieceType, type Position } from './types';

const NAMES: Record<PieceType, string> = { P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉' };
const PROMOTED_NAMES: Partial<Record<PieceType, string>> = { P: 'と', L: '成香', N: '成桂', S: '成銀', B: '馬', R: '龍' };
/** 盤上表示用の1文字 */
const PROMOTED_CHARS: Partial<Record<PieceType, string>> = { P: 'と', L: '杏', N: '圭', S: '全', B: '馬', R: '龍' };

const ZEN_DIGITS = '０１２３４５６７８９';
const KANJI_DIGITS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

export const pieceChar = (p: Piece): string => (p.promoted ? PROMOTED_CHARS[p.type]! : NAMES[p.type]);
export const pieceName = (type: PieceType, promoted = false): string => (promoted ? PROMOTED_NAMES[type]! : NAMES[type]);

const PROMOTABLE = new Set<PieceType>(['P', 'L', 'N', 'S', 'B', 'R']);
export const canPromoteType = (type: PieceType): boolean => PROMOTABLE.has(type);

/**
 * 指し手を日本語表記にする（例: "▲５七角打", "△同　玉", "▲２三銀成"）。
 * 右・左・直などの区別は省略する。
 * @param prevTo 直前の指し手の移動先（「同」表記用）
 */
export function moveToJapanese(pos: Position, usi: string, prevTo?: number): string {
  const m = parseUsiMove(usi);
  const mark = pos.turn === 'b' ? '▲' : '△';
  const { file, rank } = indexToSquare(m.to);
  const dest = prevTo === m.to ? '同　' : `${ZEN_DIGITS[file]}${KANJI_DIGITS[rank]}`;
  if (m.kind === 'drop') return `${mark}${dest}${NAMES[m.type]}打`;
  const piece = pos.board[m.from];
  if (!piece) return `${mark}${dest}?`;
  let s = `${mark}${dest}${pieceName(piece.type, piece.promoted)}`;
  if (m.promote) s += '成';
  else if (!piece.promoted && canPromoteType(piece.type) && inPromotionZone(piece.color, m.from, m.to)) s += '不成';
  return s;
}

/** 移動元または移動先が敵陣（相手側3段）か */
export function inPromotionZone(color: 'b' | 'w', from: number, to: number): boolean {
  const zone = (i: number) => {
    const r = Math.floor(i / 9);
    return color === 'b' ? r <= 2 : r >= 6;
  };
  return zone(from) || zone(to);
}

export const moveTo = (usi: string): number => parseUsiMove(usi).to;
