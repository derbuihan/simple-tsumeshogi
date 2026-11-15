import { parseProblemLine, type Problem } from '../game/problem';

/** public/problems/index.json: 手数ごとの巻ごと問題数 */
export type ProblemIndex = Record<string, { moves: number; volumes: number[] }>;

export const PROBLEM_LENGTHS = [3, 5, 7, 9, 11] as const;
export type ProblemLength = (typeof PROBLEM_LENGTHS)[number];

const BASE = `${import.meta.env.BASE_URL}problems/`;
const volumeCache = new Map<string, Promise<string[]>>();
let indexPromise: Promise<ProblemIndex> | null = null;

export function loadIndex(): Promise<ProblemIndex> {
  indexPromise ??= fetch(`${BASE}index.json`).then((r) => {
    if (!r.ok) throw new Error(`failed to load problem index: ${r.status}`);
    return r.json();
  });
  return indexPromise;
}

const pad3 = (n: number) => String(n).padStart(3, '0');
export const problemId = (length: number, volume: number, line: number) => `mate${length}/${pad3(volume)}/${line}`;

/** 1巻（約1000問）を読み込む。読み込んだ巻はメモリにキャッシュする */
export function loadVolume(length: number, volume: number): Promise<string[]> {
  const key = `mate${length}/${pad3(volume)}`;
  let p = volumeCache.get(key);
  if (!p) {
    p = fetch(`${BASE}${key}.txt`)
      .then((r) => {
        if (!r.ok) throw new Error(`failed to load ${key}: ${r.status}`);
        return r.text();
      })
      .then((t) => t.split('\n').filter((l) => l.trim()));
    p.catch(() => volumeCache.delete(key));
    volumeCache.set(key, p);
  }
  return p;
}

export async function loadProblem(id: string): Promise<Problem> {
  const m = id.match(/^mate(\d+)\/(\d{3})\/(\d+)$/);
  if (!m) throw new Error(`invalid problem id: ${id}`);
  const lines = await loadVolume(Number(m[1]), Number(m[2]));
  const line = lines[Number(m[3])];
  if (!line) throw new Error(`problem not found: ${id}`);
  return parseProblemLine(id, line);
}
