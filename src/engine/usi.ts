/** 探索結果の評価値。value は手番側から見た値（mate は手数、負なら手番側が詰まされる）。 */
export type Score = { kind: 'cp'; value: number } | { kind: 'mate'; value: number; sign: '+' | '-' };

export interface ThinkResult {
  bestmove: string;
  /** 最後に受け取った info の score。探索が一度も info を出さなければ null */
  score: Score | null;
  pv: string[];
}

/** "info ... score mate -5 ... pv 7g7f ..." から score と pv を取り出す */
export function parseInfo(line: string): { score: Score | null; pv: string[] } | null {
  if (!line.startsWith('info ')) return null;
  const tokens = line.split(/\s+/);
  let score: Score | null = null;
  let pv: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] === 'score') {
      const kind = tokens[i + 1];
      const raw = tokens[i + 2] ?? '';
      if (kind === 'cp') score = { kind: 'cp', value: Number(raw) };
      else if (kind === 'mate') {
        // "mate -0" / "mate +" / "mate -" のように手数が無い・0 の場合もある
        const sign = raw.startsWith('-') ? '-' : '+';
        const n = Number(raw.replace(/^[+-]/, ''));
        score = { kind: 'mate', value: Number.isFinite(n) ? (sign === '-' ? -n : n) : 0, sign };
      }
      i += 2;
    } else if (tokens[i] === 'pv') {
      pv = tokens.slice(i + 1);
      break;
    }
  }
  if (!score && pv.length === 0) return null;
  return { score, pv };
}

/** "bestmove 7g7f ponder 3c3d" → "7g7f" */
export function parseBestmove(line: string): string | null {
  if (!line.startsWith('bestmove')) return null;
  return line.split(/\s+/)[1] ?? null;
}

/** 手番側（玉方）が詰まされると読んでいるか */
export const isMatedScore = (s: Score | null): boolean => s?.kind === 'mate' && s.sign === '-';
