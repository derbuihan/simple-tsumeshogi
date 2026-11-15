#!/usr/bin/env python3
"""Keep only problems proven solvable in their target mate length after hand reduction.

Input records use the repository's shogimate format:
    <SFEN> moves <recorded solution moves>

For each problem, attacker pieces not required by the recorded line are moved
to the defender's hand. The official YaneuraOu mate engine then proves (or
fails to prove) a mate within the target ply limit. Only a proof with exactly
the target number of plies is written, using the engine's proven PV.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import subprocess
import sys
import threading
import time
from collections import Counter
from pathlib import Path

PIECES = "RBGSNLP"
BOOKS = ("mate3", "mate5", "mate7", "mate9", "mate11")


def parse_hand(text: str) -> dict[str, Counter[str]]:
    hands = {"b": Counter(), "w": Counter()}
    digits = ""
    for char in "" if text == "-" else text:
        if char.isdigit():
            digits += char
            continue
        color = "b" if char.isupper() else "w"
        hands[color][char.upper()] += int(digits or "1")
        digits = ""
    if digits:
        raise ValueError(f"incomplete hand count: {text}")
    return hands


def format_hand(hands: dict[str, Counter[str]]) -> str:
    parts: list[str] = []
    for color in ("b", "w"):
        for piece in PIECES:
            count = hands[color][piece]
            if count:
                parts.append((str(count) if count > 1 else "") + (piece if color == "b" else piece.lower()))
    return "".join(parts) or "-"


def square(text: str) -> tuple[int, int]:
    if len(text) != 2 or text[0] not in "123456789" or text[1] not in "abcdefghi":
        raise ValueError(f"invalid USI square: {text}")
    return int(text[0]), ord(text[1]) - ord("a")


def reduce_attacker_hand(sfen: str, moves: list[str]) -> tuple[str, Counter[str]]:
    board_text, turn, hand_text, ply = sfen.split()
    if turn not in ("b", "w"):
        raise ValueError(f"invalid side to move: {turn}")

    board: dict[tuple[int, int], tuple[str, str]] = {}
    for rank, row in enumerate(board_text.split("/")):
        file = 9
        promoted = False
        for char in row:
            if char == "+":
                if promoted:
                    raise ValueError(f"invalid promoted piece in SFEN: {sfen}")
                promoted = True
                continue
            if char.isdigit():
                file -= int(char)
                promoted = False
                continue
            if char.upper() not in PIECES + "K" or not 1 <= file <= 9 or not 0 <= rank <= 8:
                raise ValueError(f"invalid board in SFEN: {sfen}")
            board[(file, rank)] = ("b" if char.isupper() else "w", char.upper())
            file -= 1
            promoted = False
        if file != 0:
            raise ValueError(f"invalid rank width in SFEN: {row}")

    hands = parse_hand(hand_text)
    original_attacker = hands[turn].copy()
    need: Counter[str] = Counter()
    gained_by_capture: Counter[str] = Counter()
    color = turn

    for move in moves:
        if len(move) < 4:
            raise ValueError(f"invalid move: {move}")
        if move[1] == "*":
            piece = move[0].upper()
            if piece not in PIECES:
                raise ValueError(f"invalid drop: {move}")
            if color == turn:
                if gained_by_capture[piece]:
                    gained_by_capture[piece] -= 1
                else:
                    need[piece] += 1
            dst = square(move[2:4])
            if dst in board:
                raise ValueError(f"drop onto occupied square: {move}")
            board[dst] = (color, piece)
        else:
            src, dst = square(move[:2]), square(move[2:4])
            if src not in board:
                raise ValueError(f"move from empty square: {move}")
            captured = board.get(dst)
            if captured and color == turn:
                gained_by_capture[captured[1]] += 1
            piece = board.pop(src)
            if captured and captured[0] == color:
                raise ValueError(f"move captures own piece: {move}")
            board[dst] = piece
        color = "w" if color == "b" else "b"

    if any(need[piece] > original_attacker[piece] for piece in need):
        raise ValueError("recorded solution needs more of a piece than the original attacker hand")

    defender = "w" if turn == "b" else "b"
    for piece in PIECES:
        hands[defender][piece] += original_attacker[piece] - need[piece]
    hands[turn] = need
    return f"{board_text} {turn} {format_hand(hands)} {ply}", need


def read_until(lines: queue.Queue[str | None], predicate, timeout: float) -> list[str]:
    deadline = time.monotonic() + timeout
    collected: list[str] = []
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("\n".join(collected[-12:]))
        try:
            line = lines.get(timeout=remaining)
        except queue.Empty as exc:
            raise TimeoutError("\n".join(collected[-12:])) from exc
        if line is None:
            raise RuntimeError("mate engine closed its output: " + "\n".join(collected[-12:]))
        line = line.rstrip("\r\n")
        collected.append(line)
        if predicate(line):
            return collected


class MateEngine:
    def __init__(self, executable: Path, hash_mb: int):
        self.executable = executable
        self.hash_mb = hash_mb
        self.process: subprocess.Popen[str] | None = None
        self.lines: queue.Queue[str | None] = queue.Queue()

    def start(self) -> None:
        self.lines = queue.Queue()
        self.process = subprocess.Popen(
            [str(self.executable)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1,
        )
        assert self.process.stdout is not None
        threading.Thread(target=self._pump, daemon=True).start()
        self.send("usi")
        read_until(self.lines, lambda line: line == "usiok", 60)
        for name, value in (
            ("Threads", "1"),
            ("SolverType", "32bitNodeSolver"),
            ("USI_Hash", str(self.hash_mb)),
            ("PvInterval", "0"),
        ):
            self.send(f"setoption name {name} value {value}")
        self.send("isready")
        read_until(self.lines, lambda line: line == "readyok", 180)

    def _pump(self) -> None:
        assert self.process and self.process.stdout
        for line in self.process.stdout:
            self.lines.put(line)
        self.lines.put(None)

    def send(self, command: str) -> None:
        if not self.process or not self.process.stdin or self.process.poll() is not None:
            raise RuntimeError("mate engine is not running")
        self.process.stdin.write(command + "\n")
        self.process.stdin.flush()

    def solve(self, sfen: str, target_plies: int, timeout_ms: int, retries: int) -> tuple[str, list[str]]:
        for attempt in range(retries + 1):
            try:
                self.send(f"setoption name DepthLimit value {target_plies}")
                self.send(f"position sfen {sfen}")
                self.send(f"go mate {timeout_ms}")
                try:
                    output = read_until(
                        self.lines, lambda line: line.startswith("checkmate "),
                        timeout_ms / 1000 + 30,
                    )
                except TimeoutError:
                    self.send("stop")
                    try:
                        output = read_until(self.lines, lambda line: line.startswith("checkmate "), 30)
                    except (TimeoutError, RuntimeError) as exc:
                        raise RuntimeError(f"engine did not stop cleanly: {exc}") from exc
                result = next(line for line in reversed(output) if line.startswith("checkmate "))
                return result, output
            except (BrokenPipeError, RuntimeError, TimeoutError) as exc:
                self.close(kill=True)
                if attempt >= retries:
                    raise RuntimeError(f"engine failed after {retries + 1} attempts: {exc}") from exc
                print(f"RETRY engine attempt {attempt + 2}/{retries + 1}: {exc}", file=sys.stderr, flush=True)
                self.start()
        raise AssertionError("unreachable")

    def close(self, kill: bool = False) -> None:
        if not self.process:
            return
        process = self.process
        if process.poll() is None and not kill:
            try:
                self.send("quit")
            except (BrokenPipeError, RuntimeError):
                pass
        if process.poll() is None:
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        self.process = None


def classify(result: str, target: int) -> tuple[str, list[str]]:
    if result == "checkmate nomate":
        return "NO", []
    if result in ("checkmate none", "checkmate timeout"):
        return "UNKNOWN", []
    pv = result.removeprefix("checkmate ").split()
    return ("YES" if len(pv) == target else "NO"), pv


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".tmp-{os.getpid()}-{threading.get_ident()}")
    temporary.write_text(json.dumps(value, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def source_signature(path: Path) -> dict[str, int]:
    stat = path.stat()
    return {"size": stat.st_size, "mtime_ns": stat.st_mtime_ns}


def process_file(
    source: Path, input_root: Path, output_root: Path, state_root: Path,
    engine: MateEngine, timeout_ms: int, retries: int, config_key: str, max_records: int | None,
) -> dict:
    relative = source.relative_to(input_root)
    output = output_root / relative
    state = state_root / relative.with_suffix(relative.suffix + ".json")
    signature = source_signature(source)
    if max_records is None and output.exists() and state.exists():
        try:
            previous = json.loads(state.read_text(encoding="utf-8"))
            if previous.get("signature") == signature and previous.get("config") == config_key:
                return {"file": str(relative), "skipped": True, **previous["counts"]}
        except (OSError, ValueError, KeyError):
            pass

    target = int(source.parent.name.removeprefix("mate"))
    counts: Counter[str] = Counter()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + f".tmp-{os.getpid()}-{threading.get_ident()}")
    try:
        with source.open("r", encoding="utf-8") as input_file, temporary.open("w", encoding="utf-8") as output_file:
            for line_number, raw in enumerate(input_file, 1):
                line = raw.strip()
                if not line:
                    continue
                if max_records is not None and counts["processed"] >= max_records:
                    break
                counts["processed"] += 1
                try:
                    sfen, moves_text = line.split(" moves ", 1)
                    moves = moves_text.split()
                    transformed, _ = reduce_attacker_hand(sfen, moves)
                    result, _ = engine.solve(transformed, target, timeout_ms, retries)
                    status, pv = classify(result, target)
                    counts[status] += 1
                    if status == "YES":
                        output_file.write(f"{transformed} moves {' '.join(pv)}\n")
                except Exception as exc:  # bad record; keep processing the remaining records
                    counts["ERROR"] += 1
                    counts["error_examples"] += 1
                    if counts["error_examples"] <= 3:
                        print(f"ERROR {relative}:{line_number}: {exc}", file=sys.stderr, flush=True)
                if counts["processed"] % 500 == 0:
                    output_file.flush()
        os.replace(temporary, output)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise

    summary = {key: counts[key] for key in ("processed", "YES", "NO", "UNKNOWN", "ERROR")}
    record = {
        "signature": signature, "config": config_key, "counts": summary,
        "output": str(relative), "completed_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    if max_records is None and counts["ERROR"] == 0:
        atomic_json(state, record)
    return {"file": str(relative), **summary, "skipped": False}


def available_memory_mb() -> int | None:
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) // 1024
    except OSError:
        return None
    return None


def worker_loop(tasks: queue.Queue[Path | None], results: queue.Queue[dict], args, roots, config_key: str, engine: MateEngine) -> None:
    try:
        while True:
            source = tasks.get()
            try:
                if source is None:
                    return
                try:
                    results.put(process_file(
                        source, roots[0], roots[1], roots[2], engine,
                        args.timeout_ms, args.retries, config_key, args.limit_records,
                    ))
                except Exception as exc:
                    results.put({"file": str(source), "fatal": str(exc)})
            finally:
                tasks.task_done()
    finally:
        engine.close()


def main() -> int:
    project = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=project / ".cache/shogimate/public/data")
    parser.add_argument("--output", type=Path, default=project / ".cache/minimal-hand/public/data")
    parser.add_argument("--state", type=Path, default=project / ".cache/minimal-hand/state")
    parser.add_argument("--engine", type=Path, default=project / ".cache/research/YaneuraOu/source/YaneuraOu-by-gcc")
    parser.add_argument("--workers", type=int, default=0, help="0 selects a CPU and memory safe count")
    parser.add_argument("--hash-mb", type=int, default=4096, help="DFPN hash memory per worker")
    parser.add_argument("--timeout-ms", type=int, default=30000, help="per-position engine limit")
    parser.add_argument("--retries", type=int, default=2, help="retries after an engine or response failure")
    parser.add_argument("--limit-files", type=int, default=0, help="process at most this many files (pilot runs)")
    parser.add_argument("--limit-records", type=int, default=None, help="process at most this many records per file; disables resume markers")
    args = parser.parse_args()

    input_root = args.input.resolve()
    output_root = args.output.resolve()
    state_root = args.state.resolve()
    args.engine = args.engine.resolve()
    if not input_root.is_dir():
        parser.error(f"input directory not found: {input_root} (fetch data first with npm run fetch:problems)")
    if not args.engine.is_file() or not os.access(args.engine, os.X_OK):
        parser.error(f"executable mate engine not found: {args.engine}")
    if args.hash_mb < 1 or args.timeout_ms < 1 or args.workers < 0 or args.retries < 0:
        parser.error("hash, timeout and worker settings must be positive; retries cannot be negative")
    if args.limit_records is not None and args.limit_records < 1:
        parser.error("--limit-records must be positive")
    if args.limit_files < 0:
        parser.error("--limit-files cannot be negative")
    for book in BOOKS:
        if not (input_root / book).is_dir():
            parser.error(f"expected input folder is missing: {input_root / book}")
    if output_root == input_root or input_root in output_root.parents or output_root in input_root.parents:
        parser.error("output must be separate from and outside the input directory")

    files = sorted(path for book in BOOKS for path in (input_root / book).rglob("*.txt"))
    if args.limit_files:
        files = files[:args.limit_files]
    if not files:
        parser.error("no .txt problem files found")

    workers = args.workers
    if workers == 0:
        cpu_limit = os.cpu_count() or 1
        memory = available_memory_mb()
        memory_limit = max(1, int(memory * 0.75 // args.hash_mb)) if memory else cpu_limit
        workers = max(1, min(cpu_limit, memory_limit, 24))
    config_key = f"{args.engine}:{args.engine.stat().st_mtime_ns}:{args.hash_mb}:{args.timeout_ms}:retries{args.retries}:dfpn32-exact-pv-v2"
    print(json.dumps({
        "files": len(files), "workers": workers, "hash_mb_each": args.hash_mb,
        "timeout_ms": args.timeout_ms, "retries": args.retries,
        "input": str(input_root), "output": str(output_root),
    }, ensure_ascii=False), flush=True)

    tasks: queue.Queue[Path | None] = queue.Queue()
    results: queue.Queue[dict] = queue.Queue()
    for source in files:
        tasks.put(source)
    engines: list[MateEngine] = []
    try:
        for index in range(workers):
            engine = MateEngine(args.engine, args.hash_mb)
            engine.start()
            engines.append(engine)
            print(f"engine {index + 1}/{workers} ready", flush=True)
    except Exception as exc:
        for engine in engines:
            engine.close(kill=True)
        print(f"failed to start all worker engines: {exc}", file=sys.stderr)
        return 2

    threads = [
        threading.Thread(target=worker_loop, args=(tasks, results, args, (input_root, output_root, state_root), config_key, engine), daemon=True)
        for engine in engines
    ]
    for thread in threads:
        thread.start()

    for _ in threads:
        tasks.put(None)
    totals: Counter[str] = Counter()
    completed = 0
    started = time.monotonic()
    while completed < len(files):
        item = results.get()
        completed += 1
        for key in ("processed", "YES", "NO", "UNKNOWN", "ERROR"):
            totals[key] += int(item.get(key, 0))
        if item.get("fatal"):
            totals["FATAL"] += 1
            print(f"FAILED {item.get('file')}: {item['fatal']}", file=sys.stderr, flush=True)
        if completed % 10 == 0 or completed == len(files):
            print(json.dumps({
                "files_done": completed, "files_total": len(files), "records": totals["processed"],
                "yes": totals["YES"], "no": totals["NO"], "unknown": totals["UNKNOWN"],
                "errors": totals["ERROR"], "elapsed_seconds": round(time.monotonic() - started, 1),
            }), flush=True)
    for thread in threads:
        thread.join()
    print(json.dumps({"complete": totals["FATAL"] == 0, "output": str(output_root), **totals}, ensure_ascii=False), flush=True)
    return 1 if totals["FATAL"] or totals["ERROR"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
