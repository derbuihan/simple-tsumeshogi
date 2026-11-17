#!/usr/bin/env python3
"""Rebuild the recorded solutions so the defender plays like the app's defender (mini).

The minimal-hand data keeps the line the mate engine (df-pn) happened to prove. When several
defender replies lose in the same number of plies, df-pn picks one arbitrarily (e.g. a pawn
interposition where mini interposes a gold), so the shown answer disagrees with the app.

For each problem, walk the recorded line. At every defender turn with more than one legal reply,
ask the native mini (same source and eval as the app, 1 thread, fixed node count, so results are
reproducible) for its reply. If it differs, ask the official mate engine whether the attacker still
mates in exactly the remaining plies after it, and if so splice in that proof. Otherwise keep the
recorded reply. The resulting line always has the original length N.

Duplicate initial positions (same board, side and hands) are removed, keeping the first one in
mate3..mate11 / file / line order.

Problems from every length are shuffled together and handed out one at a time, so the cheap 3-ply
problems and the expensive 11-ply ones run side by side and no worker waits on a slow file.

Progress is appended to a journal; rerunning with the same settings resumes. Output files are
written once every problem is done.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import random
import sys
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LENGTHS = (3, 5, 7, 9, 11)


class EngineError(RuntimeError):
    pass


class Usi:
    """Minimal async USI client over a subprocess."""

    def __init__(self, executable: Path, options: list[tuple[str, str]]):
        self.executable = executable
        self.options = options
        self.process: asyncio.subprocess.Process | None = None

    async def start(self) -> None:
        self.process = await asyncio.create_subprocess_exec(
            str(self.executable), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, limit=1 << 22, cwd=str(self.executable.parent),
        )
        self.send("usi")
        await self.until(lambda line: line == "usiok", 60)
        for name, value in self.options:
            self.send(f"setoption name {name} value {value}")
        self.send("isready")
        await self.until(lambda line: line == "readyok", 300)

    def send(self, command: str) -> None:
        if not self.process or self.process.returncode is not None or not self.process.stdin:
            raise EngineError("engine is not running")
        self.process.stdin.write((command + "\n").encode())

    async def readline(self, timeout: float) -> str:
        assert self.process and self.process.stdout
        try:
            raw = await asyncio.wait_for(self.process.stdout.readline(), timeout)
        except asyncio.TimeoutError as exc:
            raise EngineError("engine timed out") from exc
        if not raw:
            raise EngineError("engine closed its output")
        return raw.decode().rstrip("\r\n")

    async def until(self, predicate, timeout: float) -> list[str]:
        deadline = time.monotonic() + timeout
        lines = []
        while True:
            line = await self.readline(max(0.001, deadline - time.monotonic()))
            lines.append(line)
            if predicate(line):
                return lines

    async def close(self) -> None:
        if not self.process:
            return
        if self.process.returncode is None:
            try:
                self.send("quit")
                await asyncio.wait_for(self.process.wait(), 10)
            except (EngineError, asyncio.TimeoutError, ConnectionError):
                self.process.kill()
                await self.process.wait()
        self.process = None


class Mini(Usi):
    def __init__(self, executable: Path, eval_dir: Path, nodes: int):
        super().__init__(executable, [
            ("Threads", "1"), ("USI_Hash", "16"), ("EvalDir", str(eval_dir)), ("BookFile", "no_book"),
            ("NetworkDelay", "0"), ("NetworkDelay2", "0"),
        ])
        self.nodes = nodes

    async def legal_moves(self, position: str) -> list[str]:
        # 探索中でなければ moves の応答は直後の1行（合法手がなければ空行）。isready は局面を初期化するので区切りに使わない
        self.send(position)
        self.send("moves")
        return (await self.readline(30)).split()

    async def bestmove(self, position: str) -> str:
        # 毎回置換表を消して、同じ局面なら同じ手を返すようにする
        self.send("usinewgame")
        self.send(position)
        self.send(f"go nodes {self.nodes}")
        lines = await self.until(lambda line: line.startswith("bestmove"), 600)
        return lines[-1].split()[1]


class Mate(Usi):
    def __init__(self, executable: Path, hash_mb: int, timeout_ms: int):
        super().__init__(executable, [
            ("Threads", "1"), ("SolverType", "32bitNodeSolver"), ("USI_Hash", str(hash_mb)), ("PvInterval", "0"),
        ])
        self.timeout_ms = timeout_ms

    async def solve(self, position: str, plies: int) -> list[str] | None:
        """N 手以内の詰み手順。詰まない・時間切れなら None"""
        self.send(f"setoption name DepthLimit value {plies}")
        self.send(position)
        self.send(f"go mate {self.timeout_ms}")
        lines = await self.until(lambda line: line.startswith("checkmate "), self.timeout_ms / 1000 + 60)
        result = lines[-1]
        if result in ("checkmate nomate", "checkmate none", "checkmate timeout"):
            return None
        return result.removeprefix("checkmate ").split()


def position_key(sfen: str) -> str:
    return " ".join(sfen.split()[:3])


def load_problems(input_root: Path) -> tuple[list[dict], Counter]:
    """全問題（重複を除く）。id は mateN/ファイル名:元の行番号"""
    seen: set[str] = set()
    problems: list[dict] = []
    counts: Counter = Counter()
    for n in LENGTHS:
        for path in sorted((input_root / f"mate{n}").glob("*.txt")):
            for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                line = raw.strip()
                if not line:
                    continue
                sfen, moves = line.split(" moves ", 1)
                key = position_key(sfen)
                if key in seen:
                    counts[f"mate{n}_duplicate"] += 1
                    continue
                seen.add(key)
                problems.append({"id": f"mate{n}/{path.name}:{line_number}", "n": n, "sfen": sfen, "moves": moves.split()})
    return problems, counts


async def regenerate(problem: dict, mini: Mini, mate: Mate) -> tuple[list[str], Counter]:
    sfen, n = problem["sfen"], problem["n"]
    line = list(problem["moves"])
    if len(line) != n:
        raise ValueError(f"recorded line has {len(line)} plies, expected {n}")
    stats: Counter = Counter()
    for ply in range(1, n, 2):
        position = f"position sfen {sfen} moves {' '.join(line[:ply])}"
        legal = await mini.legal_moves(position)
        if line[ply] not in legal:
            raise ValueError(f"recorded reply {line[ply]} is not legal at ply {ply + 1}")
        if len(legal) == 1:
            stats["forced"] += 1
            continue
        best = await mini.bestmove(position)
        if best == line[ply]:
            stats["same"] += 1
            continue
        if best not in legal:  # resign / win など
            stats["kept_not_a_move"] += 1
            continue
        remaining = n - ply - 1
        proof = await mate.solve(f"{position} {best}", remaining)
        if proof is not None and len(proof) == remaining:
            line = line[:ply] + [best] + proof
            stats["replaced"] += 1
        elif proof is not None:
            # mini の応手のほうが早く詰む（弱い受け）。収録の応手のほうが良いので残す
            stats["kept_mini_shorter"] += 1
        else:
            # 残り手数では詰みを証明できない（無駄合で延びる、時間切れなど）
            stats["kept_unproven"] += 1
    return line, stats


def config_key(args) -> str:
    def sig(path: Path) -> str:
        st = path.stat()
        return f"{path}:{st.st_size}:{st.st_mtime_ns}"
    text = "|".join([sig(args.mini), sig(args.mate), str(args.eval_dir), f"nodes{args.nodes}",
                     f"mate{args.mate_timeout_ms}", str(args.input), "v1"])
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def read_journal(path: Path) -> dict[str, dict]:
    done: dict[str, dict] = {}
    if not path.exists():
        return done
    with path.open(encoding="utf-8") as f:
        for raw in f:
            try:
                record = json.loads(raw)
            except ValueError:
                continue  # 中断時に書きかけになった最後の行
            done[record["id"]] = record
    return done


def write_outputs(problems: list[dict], done: dict[str, dict], output_root: Path, summary: dict) -> None:
    by_file: dict[str, list[str]] = {}
    for problem in problems:
        relative = problem["id"].rsplit(":", 1)[0]
        record = done[problem["id"]]
        by_file.setdefault(relative, []).append(f"{problem['sfen']} moves {' '.join(record['moves'])}")
    for relative, lines in by_file.items():
        path = output_root / "public/data" / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + ".tmp")
        temporary.write_text("\n".join(lines) + "\n", encoding="utf-8")
        os.replace(temporary, path)
    (output_root / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def summarize(problems: list[dict], done: dict[str, dict], load_counts: Counter) -> dict:
    summary: dict = {}
    for n in LENGTHS:
        stats: Counter = Counter()
        changed = 0
        for problem in problems:
            if problem["n"] != n or problem["id"] not in done:
                continue
            record = done[problem["id"]]
            stats.update(record.get("stats", {}))
            stats["problems"] += 1
            if record.get("error"):
                stats["error"] += 1
            if record["moves"] != problem["moves"]:
                changed += 1
        summary[f"mate{n}"] = {**dict(stats), "changed_problems": changed,
                               "duplicates_removed": load_counts.get(f"mate{n}_duplicate", 0)}
    return summary


async def main_async(args) -> int:
    problems, load_counts = load_problems(args.input)
    key = config_key(args)
    state = args.output / "state"
    state.mkdir(parents=True, exist_ok=True)
    journal_path = state / f"journal-{key}.jsonl"
    done = read_journal(journal_path)
    pending = [p for p in problems if p["id"] not in done]
    # 手数の違う問題を混ぜて1問ずつ配る（並びは固定。再開しても同じ順番）
    random.Random(1).shuffle(pending)
    if args.limit:
        pending = pending[:args.limit]
    dups = sum(load_counts.values())
    print(f"problems {len(problems)} (duplicates removed {dups}), done {len(done)}, to do {len(pending)}, "
          f"workers {args.workers}, nodes {args.nodes}, journal {journal_path.name}", flush=True)

    queue: asyncio.Queue = asyncio.Queue()
    for problem in pending:
        queue.put_nowait(problem)
    journal = journal_path.open("a", encoding="utf-8")
    progress = Counter()
    started = time.monotonic()

    async def worker() -> None:
        mini = Mini(args.mini, args.eval_dir, args.nodes)
        mate = Mate(args.mate, args.mate_hash_mb, args.mate_timeout_ms)
        await mini.start()
        await mate.start()
        try:
            while not queue.empty():
                problem = queue.get_nowait()
                record = {"id": problem["id"]}
                for attempt in range(args.retries + 1):
                    try:
                        moves, stats = await regenerate(problem, mini, mate)
                        record.update(moves=moves, stats=dict(stats))
                        break
                    except EngineError as exc:
                        await mini.close()
                        await mate.close()
                        await mini.start()
                        await mate.start()
                        if attempt == args.retries:
                            record.update(moves=problem["moves"], stats={}, error=f"engine: {exc}")
                    except ValueError as exc:
                        record.update(moves=problem["moves"], stats={}, error=str(exc))
                        break
                if record.get("error"):
                    print(f"ERROR {problem['id']}: {record['error']}", file=sys.stderr, flush=True)
                    progress["error"] += 1
                journal.write(json.dumps(record, ensure_ascii=False) + "\n")
                done[problem["id"]] = record
                progress["done"] += 1
                progress[f"mate{problem['n']}"] += 1
                if record["moves"] != problem["moves"]:
                    progress["changed"] += 1
        finally:
            await mini.close()
            await mate.close()

    def cpu_times() -> tuple[int, int] | None:
        try:
            values = list(map(int, Path("/proc/stat").read_text().split("\n", 1)[0].split()[1:9]))
        except OSError:
            return None
        return sum(values), values[3] + values[4]

    async def reporter() -> None:
        before = cpu_times()
        while True:
            await asyncio.sleep(args.report_seconds)
            journal.flush()
            now = cpu_times()
            cpu = ""
            if before and now and now[0] > before[0]:
                cpu = f" CPU {100 * (1 - (now[1] - before[1]) / (now[0] - before[0])):.0f}%"
            before = now
            elapsed = time.monotonic() - started
            rate = progress["done"] / elapsed if elapsed else 0
            left = len(pending) - progress["done"]
            eta = left / rate / 3600 if rate else float("inf")
            per = " ".join(f"{n}手:{progress[f'mate{n}']}" for n in LENGTHS)
            print(f"[{elapsed / 3600:5.2f}h] {progress['done']}/{len(pending)} ({rate:.1f}問/秒, 残り約{eta:.1f}時間){cpu} "
                  f"変わった {progress['changed']} エラー {progress['error']} | {per}", flush=True)

    report = asyncio.create_task(reporter())
    try:
        await asyncio.gather(*(worker() for _ in range(args.workers)))
    finally:
        report.cancel()
        journal.close()

    summary = summarize(problems, done, load_counts)
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    missing = [p["id"] for p in problems if p["id"] not in done]
    if missing:
        print(f"{len(missing)} problems are not done yet; outputs are not written (rerun to resume)", flush=True)
        return 0 if args.limit else 1
    write_outputs(problems, done, args.output, summary)
    print(f"wrote {args.output / 'public/data'}", flush=True)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", type=Path, default=ROOT / ".cache/minimal-hand/public/data")
    parser.add_argument("--output", type=Path, default=ROOT / ".cache/regen-solutions")
    parser.add_argument("--mini", type=Path, default=ROOT / ".cache/research/mini-native/source/YaneuraOu-by-gcc")
    parser.add_argument("--eval-dir", type=Path, default=ROOT / "public/engine/eval/mini")
    parser.add_argument("--mate", type=Path, default=ROOT / ".cache/research/YaneuraOu/source/YaneuraOu-by-gcc")
    # 📝 i7-13700K（論理24コア）で4万問を流して測定: 24並列 194問/秒 CPU 60%、32並列 220問/秒 85%、
    #    48並列 230問/秒 99%、64並列 222問/秒 100%。軽い局面はエンジンとの往復待ちが長く、論理コア数だけでは CPU が遊ぶ。
    #    メモリは1並列あたり詰み専用エンジンの置換表（--mate-hash-mb）＋約100MB
    parser.add_argument("--workers", type=int, default=2 * (os.cpu_count() or 1),
                        help="既定は論理コア数の2倍")
    parser.add_argument("--nodes", type=int, default=100000, help="mini の1回の探索で読む局面数")
    parser.add_argument("--mate-hash-mb", type=int, default=1024)
    parser.add_argument("--mate-timeout-ms", type=int, default=30000)
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--limit", type=int, default=0, help="試行用。未処理のうち先頭のこの数だけ処理し、出力は書かない")
    parser.add_argument("--report-seconds", type=float, default=60)
    args = parser.parse_args()
    for path in (args.mini, args.mate):
        if not path.exists():
            parser.error(f"{path} がありません（npm run prepare:native-mini / npm run prepare:mate-engine）")
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    sys.exit(main())
