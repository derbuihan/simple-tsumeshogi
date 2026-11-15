/** 先手 'b' / 後手 'w'（SFEN の手番表記に合わせる） */
export type Color = 'b' | 'w';

/** 駒種（成りは Piece.promoted で表す）。SFEN の大文字表記と同じ。 */
export type PieceType = 'P' | 'L' | 'N' | 'S' | 'G' | 'B' | 'R' | 'K';

export interface Piece {
  color: Color;
  type: PieceType;
  promoted: boolean;
}

/** 持ち駒にできる駒種（表示順） */
export const HAND_TYPES = ['R', 'B', 'G', 'S', 'N', 'L', 'P'] as const;
export type HandType = (typeof HAND_TYPES)[number];

export type Hand = Record<HandType, number>;

/**
 * 局面。
 * board は 81 マス。index = rank * 9 + (9 - file)。
 *   rank: 0 = 一段目（USI の 'a'） … 8 = 九段目（'i'）
 *   file: 1〜9（USI の数字）。index の列 0 が 9筋（盤面左端）。
 */
export interface Position {
  board: (Piece | null)[];
  hands: Record<Color, Hand>;
  turn: Color;
}

export const opposite = (c: Color): Color => (c === 'b' ? 'w' : 'b');

export const emptyHand = (): Hand => ({ R: 0, B: 0, G: 0, S: 0, N: 0, L: 0, P: 0 });

export const squareIndex = (file: number, rank: number): number => rank * 9 + (9 - file);
export const indexToSquare = (index: number): { file: number; rank: number } => ({
  file: 9 - (index % 9),
  rank: Math.floor(index / 9),
});
