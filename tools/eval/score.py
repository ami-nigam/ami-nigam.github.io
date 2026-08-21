#!/usr/bin/env python3
"""Score every model output against its task rubric with a vision judge.

Reads rubrics.json + models.json, sends each (source, output, rubric) triple to
Claude, and writes per-criterion verdicts plus a rolled-up adherence score to
eval_results/scores.json — the file the eval page reads.

The judge only ever grades adherence: did the image do what the instruction
asked. Subjective quality lives in ratings.json and is entered by hand through
the Judging panel on the page. Keeping the two apart is the whole point — a
model can obey perfectly and still look flat, and one number hides that.

Usage:
    export ANTHROPIC_API_KEY=...        # or: ant auth login
    pip install -r requirements.txt
    python score.py                      # score everything not yet scored
    python score.py --task t5            # one task
    python score.py --model "FLUX.2 Max" # one model, all tasks
    python score.py --force              # re-score, ignoring existing results
    python score.py --dry-run            # list the work without calling the API
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

try:
    import anthropic
except ImportError:  # --dry-run should work before anyone has installed anything
    anthropic = None

HERE = Path(__file__).resolve().parent
TOOLS = HERE.parent
RESULTS = TOOLS / "eval_results"
SCORES_PATH = RESULTS / "scores.json"

JUDGE_MODEL = "claude-opus-5"
# Claude downsamples anything larger anyway; doing it here keeps requests small
# and the token cost per judgement predictable.
MAX_EDGE = 1568

SYSTEM = """You are grading the output of an image-generation model against the \
instruction it was given, for an architectural visualisation benchmark.

You are shown two images: first the SOURCE image the model was given, then the \
OUTPUT it returned. You are also given the verbatim instruction and a list of \
criteria.

Grade each criterion independently:
  pass    — the criterion is clearly met
  partial — partly met, or met with a caveat the criterion's test names
  fail    — not met

Rules:
- Judge only what the criterion asks. Do not let a beautiful image earn a pass on \
a preservation criterion, and do not penalise an ugly image on a criterion it \
satisfies. Aesthetic quality is graded by a human elsewhere and is not your job.
- Compare against the SOURCE image, not against your expectations of what the \
building should look like.
- Give one sentence of concrete visual evidence for every verdict, citing what you \
actually see and where. "Looks fine" is not evidence.
- Be strict on criteria whose test says a violation is a fail. These encode hard \
constraints from the instruction.
- Return a verdict for every criterion id given, and invent no others."""

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "criteria": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "verdict": {"type": "string", "enum": ["pass", "partial", "fail"]},
                    "evidence": {"type": "string"},
                },
                "required": ["id", "verdict", "evidence"],
                "additionalProperties": False,
            },
        },
        "summary": {
            "type": "string",
            "description": "One or two sentences on how this output did against the instruction overall.",
        },
    },
    "required": ["criteria", "summary"],
    "additionalProperties": False,
}


def load_json(path: Path) -> dict:
    with path.open() as f:
        return json.load(f)


def encode_image(path: Path) -> dict:
    """Read an image as a base64 content block, downscaling when Pillow is around."""
    raw = path.read_bytes()
    try:
        from PIL import Image

        img = Image.open(io.BytesIO(raw))
        if max(img.size) > MAX_EDGE:
            scale = MAX_EDGE / max(img.size)
            img = img.convert("RGB").resize(
                (max(1, round(img.width * scale)), max(1, round(img.height * scale))),
                Image.LANCZOS,
            )
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=90)
            raw = buf.getvalue()
    except ImportError:
        pass  # Pillow is a nicety, not a requirement — send the original bytes.

    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": "image/jpeg",
            "data": base64.standard_b64encode(raw).decode("utf-8"),
        },
    }


def build_prompt(task: dict) -> str:
    lines = [
        f"TASK {task['number']} — {task['title']}",
        "",
        "INSTRUCTION GIVEN TO THE MODEL (verbatim):",
        f'"{task["prompt"]}"',
        "",
        "CRITERIA:",
    ]
    for c in task["criteria"]:
        lines.append(f"- {c['id']} (weight {c['weight']}) — {c['label']}: {c['test']}")
    lines += [
        "",
        "The first image is the SOURCE. The second is the model's OUTPUT.",
        "Grade every criterion above and return the structured result.",
    ]
    return "\n".join(lines)


def adherence(task: dict, verdicts: dict[str, str]) -> float:
    scale = {"pass": 1.0, "partial": 0.5, "fail": 0.0}
    total = sum(c["weight"] for c in task["criteria"])
    got = sum(c["weight"] * scale.get(verdicts.get(c["id"], "fail"), 0.0) for c in task["criteria"])
    return round(100 * got / total, 1) if total else 0.0


def judge(client: anthropic.Anthropic, task: dict, model: dict, use_fallbacks: bool) -> dict:
    source = TOOLS / task["source"]
    output = RESULTS / task["folder"] / "images" / f"{model['slug']}.jpg"
    if not output.exists():
        raise FileNotFoundError(f"no output image: {output}")

    content = [encode_image(source), encode_image(output), {"type": "text", "text": build_prompt(task)}]
    request = {
        "model": JUDGE_MODEL,
        "max_tokens": 16000,
        "system": SYSTEM,
        "thinking": {"type": "adaptive"},
        "output_config": {"format": {"type": "json_schema", "schema": RESPONSE_SCHEMA}, "effort": "high"},
        "messages": [{"role": "user", "content": content}],
    }

    if use_fallbacks:
        try:
            response = client.beta.messages.create(
                betas=["server-side-fallback-2026-07-01"], fallbacks="default", **request
            )
        except anthropic.BadRequestError:
            # The fallback beta isn't available on this account — carry on without it.
            response = client.messages.create(**request)
    else:
        response = client.messages.create(**request)

    if response.stop_reason == "refusal":
        raise RuntimeError(f"judge refused: {getattr(response.stop_details, 'explanation', '')}")

    text = next(b.text for b in response.content if b.type == "text")
    parsed = json.loads(text)

    valid = {c["id"] for c in task["criteria"]}
    graded = {}
    for entry in parsed["criteria"]:
        if entry["id"] in valid:
            graded[entry["id"]] = entry

    missing = valid - graded.keys()
    if missing:
        raise RuntimeError(f"judge skipped criteria: {', '.join(sorted(missing))}")

    return {
        "adherence": adherence(task, {k: v["verdict"] for k, v in graded.items()}),
        "criteria": {
            k: {"verdict": v["verdict"], "evidence": v["evidence"]} for k, v in graded.items()
        },
        "summary": parsed["summary"],
        "judged_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--task", action="append", help="task id (t1..t5); repeatable")
    ap.add_argument("--model", action="append", help="model name; repeatable")
    ap.add_argument("--force", action="store_true", help="re-score entries that already exist")
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--dry-run", action="store_true", help="list the work and exit")
    ap.add_argument("--no-fallbacks", action="store_true", help="skip the server-side refusal fallback beta")
    args = ap.parse_args()

    rubrics = load_json(HERE / "rubrics.json")
    roster = load_json(HERE / "models.json")

    tasks = [t for t in rubrics["tasks"] if not args.task or t["id"] in args.task]
    models = [m for m in roster["models"] if not args.model or m["name"] in args.model]
    if not tasks or not models:
        print("nothing selected — check --task / --model", file=sys.stderr)
        return 1

    scores = load_json(SCORES_PATH) if SCORES_PATH.exists() else {}
    scores.setdefault("version", 1)
    scores.setdefault("scores", {})
    stale = scores.get("rubric_version") not in (None, rubrics["version"])
    if stale and not args.force:
        print(
            f"warning: scores.json was built against rubric version "
            f"{scores.get('rubric_version')}, rubrics.json is now version {rubrics['version']}. "
            f"Re-run with --force to re-score against the current rubric.",
            file=sys.stderr,
        )

    work = []
    for task in tasks:
        done = scores["scores"].get(task["id"], {})
        for model in models:
            if not args.force and model["name"] in done:
                continue
            if not (RESULTS / task["folder"] / "images" / f"{model['slug']}.jpg").exists():
                print(f"skip  {task['id']:>3}  {model['name']} — no output image")
                continue
            work.append((task, model))

    if not work:
        print("nothing to do — everything selected is already scored (use --force to redo)")
        return 0

    print(f"{len(work)} judgement(s) to run against {JUDGE_MODEL}")
    if args.dry_run:
        for task, model in work:
            print(f"  {task['id']}  {model['name']}")
        return 0

    if anthropic is None:
        print("the anthropic SDK is not installed — pip install -r requirements.txt", file=sys.stderr)
        return 1

    client = anthropic.Anthropic()
    lock = threading.Lock()
    failures = 0

    def run(item):
        task, model = item
        return task, model, judge(client, task, model, not args.no_fallbacks)

    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = {pool.submit(run, item): item for item in work}
        for future in as_completed(futures):
            task, model = futures[future]
            try:
                task, model, result = future.result()
            except Exception as exc:  # noqa: BLE001 — one bad judgement shouldn't sink the run
                failures += 1
                print(f"FAIL  {task['id']:>3}  {model['name']}: {exc}", file=sys.stderr)
                continue

            with lock:
                scores["scores"].setdefault(task["id"], {})[model["name"]] = result
                scores["rubric_version"] = rubrics["version"]
                scores["judge_model"] = JUDGE_MODEL
                scores["generated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
                # Write through after every result so a crash or a Ctrl-C keeps
                # the work already paid for.
                tmp = SCORES_PATH.with_suffix(".json.tmp")
                tmp.write_text(json.dumps(scores, indent=2, sort_keys=True) + "\n")
                tmp.replace(SCORES_PATH)

            print(f"  ok  {task['id']:>3}  {model['name']:<24} {result['adherence']:>5.1f}")

    print(f"\nwrote {SCORES_PATH.relative_to(TOOLS.parent)}")
    if failures:
        print(f"{failures} judgement(s) failed — re-run to retry just those", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
