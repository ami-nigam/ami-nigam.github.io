#!/usr/bin/env python3
"""Support tooling for grading model outputs against the task rubrics.

The judging itself is done by Claude reading the images in-session — there is no
API call here and no key to set. This script does the two jobs a program is
genuinely better at than a person reading pictures:

  prep    Stitch each source/output pair into one side-by-side sheet, plus a
          contact sheet per task. Judging a material swap or a constrained zoom
          means comparing against the source; putting both in a single frame
          makes that one look instead of two, and catches things — bleed into
          adjacent surfaces, a camera that shifted slightly — that are invisible
          when the images are viewed apart.

  tally   Turn hand-written verdicts into scores.json: validate every criterion
          id against the rubric, apply the weights, roll up to an adherence
          score. Catches a missed or invented criterion, which is the mistake
          that actually happens when grading 65 images by eye.

  status  What has been scored and rated so far, and what is left.

Typical loop:

    python evalkit.py prep --task t1
    #   ... read tools/eval/sheets/t1/*.jpg, write verdicts to a JSON file ...
    python evalkit.py tally my-verdicts.json
    #   ... then rate quality 1-5 in the page's judging panel and export ...

Verdict file format — one or more tasks per file:

    {
      "t1": {
        "FLUX.2 Max": {
          "summary": "Held the building exactly; the strongest daylight read.",
          "criteria": {
            "massing":  ["pass", "All three volumes match the source silhouette."],
            "camera":   ["pass", "Horizon and framing unchanged."],
            "photoreal":["partial", "Glass is convincing, podium still reads CG."]
          }
        }
      }
    }

Verdicts are pass / partial / fail. Every criterion the rubric lists must be
present, and nothing else may be.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
TOOLS = HERE.parent
RESULTS = TOOLS / "eval_results"
SCORES_PATH = RESULTS / "scores.json"
RATINGS_PATH = RESULTS / "ratings.json"
SHEETS = HERE / "sheets"

JUDGE = "claude-opus-5 (in-session, vision)"
VERDICT_VALUES = {"pass": 1.0, "partial": 0.5, "fail": 0.0}

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "C:/Windows/Fonts/arial.ttf",
]


def load(path: Path) -> dict:
    with path.open() as f:
        return json.load(f)


def rubrics() -> dict:
    return load(HERE / "rubrics.json")


def models() -> list:
    return load(HERE / "models.json")["models"]


def find_task(rb: dict, tid: str) -> dict | None:
    for t in rb["tasks"]:
        if t["id"] == tid:
            return t
    return None


def output_path(task: dict, slug: str) -> Path:
    return RESULTS / task["folder"] / "images" / f"{slug}.jpg"


# ---------------------------------------------------------------- prep

def _font(size: int):
    from PIL import ImageFont

    for p in FONT_CANDIDATES:
        if Path(p).exists():
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                continue
    return ImageFont.load_default()


def _fit(img, box_w: int, box_h: int):
    from PIL import Image

    scale = min(box_w / img.width, box_h / img.height)
    if scale < 1:
        img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)
    return img


def _label_bar(draw, x: int, y: int, w: int, text: str, font, bg, fg):
    draw.rectangle([x, y, x + w, y + 30], fill=bg)
    draw.text((x + 10, y + 8), text, font=font, fill=fg)


def build_pair(task: dict, model: dict, panel_h: int, out_dir: Path) -> Path | None:
    """Source and output in one frame, each labelled, at a comparable height."""
    from PIL import Image, ImageDraw

    src_path = TOOLS / task["source"]
    out_path = output_path(task, model["slug"])
    if not out_path.exists():
        return None

    src = _fit(Image.open(src_path).convert("RGB"), panel_h * 2, panel_h)
    out = _fit(Image.open(out_path).convert("RGB"), panel_h * 2, panel_h)

    gap, bar = 8, 30
    W = src.width + gap + out.width
    H = bar + max(src.height, out.height)
    sheet = Image.new("RGB", (W, H), (22, 20, 15))
    sheet.paste(src, (0, bar))
    sheet.paste(out, (src.width + gap, bar))

    draw = ImageDraw.Draw(sheet)
    font = _font(17)
    _label_bar(draw, 0, 0, src.width, "SOURCE", font, (12, 11, 9), (235, 232, 226))
    _label_bar(draw, src.width + gap, 0, out.width, model["name"], font, (150, 20, 90), (255, 255, 255))

    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / f"{model['slug']}.jpg"
    sheet.save(dest, "JPEG", quality=88)
    return dest


def build_contact(task: dict, roster: list, out_dir: Path, cols: int = 4, cell_w: int = 460) -> Path | None:
    """Every output for one task in a labelled grid — an orientation pass before
    the per-model detail, and the fastest way to spot the outright failures."""
    from PIL import Image, ImageDraw

    have = [m for m in roster if output_path(task, m["slug"]).exists()]
    if not have:
        return None

    cell_h = int(cell_w * 9 / 16)
    bar = 26
    rows = (len(have) + cols - 1) // cols
    W = cols * cell_w + (cols + 1) * 6
    H = rows * (cell_h + bar) + (rows + 1) * 6 + 34
    sheet = Image.new("RGB", (W, H), (22, 20, 15))
    draw = ImageDraw.Draw(sheet)
    draw.text((8, 9), f"TASK {task['number']} — {task['title']}", font=_font(19), fill=(235, 232, 226))

    font = _font(15)
    for i, m in enumerate(have):
        r, c = divmod(i, cols)
        x = 6 + c * (cell_w + 6)
        y = 34 + 6 + r * (cell_h + bar + 6)
        img = _fit(Image.open(output_path(task, m["slug"])).convert("RGB"), cell_w, cell_h)
        _label_bar(draw, x, y, cell_w, m["name"], font, (150, 20, 90), (255, 255, 255))
        sheet.paste(img, (x + (cell_w - img.width) // 2, y + bar))

    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / "_contact.jpg"
    sheet.save(dest, "JPEG", quality=86)
    return dest


def cmd_prep(args) -> int:
    try:
        import PIL  # noqa: F401
    except ImportError:
        print("Pillow is required for prep — pip install -r requirements.txt", file=sys.stderr)
        return 1

    rb, roster = rubrics(), models()
    tasks = [t for t in rb["tasks"] if not args.task or t["id"] in args.task]
    if not tasks:
        print("no such task — expected one of " + ", ".join(t["id"] for t in rb["tasks"]), file=sys.stderr)
        return 1

    root = Path(args.out).resolve() if args.out else SHEETS
    made = 0
    for task in tasks:
        out_dir = root / task["id"]
        for m in roster:
            if build_pair(task, m, args.height, out_dir):
                made += 1
            else:
                print(f"  no output image for {task['id']} / {m['name']}")
        if not args.no_contact:
            build_contact(task, roster, out_dir)
        print(f"{task['id']}  ->  {out_dir}")

    print(f"\n{made} comparison sheet(s) written. Read the _contact.jpg in each task "
          f"folder first, then the per-model sheets.")
    return 0


# ---------------------------------------------------------------- tally

def cmd_tally(args) -> int:
    rb = rubrics()
    known_models = {m["name"] for m in models()}

    scores = load(SCORES_PATH) if SCORES_PATH.exists() else {}
    scores.setdefault("version", 1)
    scores.setdefault("scores", {})

    problems, written = [], 0

    for path in args.verdicts:
        p = Path(path)
        if not p.exists():
            problems.append(f"{path}: no such file")
            continue
        data = load(p)

        for tid, per_model in data.items():
            task = find_task(rb, tid)
            if not task:
                problems.append(f"{p.name}: unknown task '{tid}'")
                continue
            wanted = {c["id"]: c["weight"] for c in task["criteria"]}

            for name, entry in per_model.items():
                where = f"{p.name} / {tid} / {name}"
                if name not in known_models:
                    problems.append(f"{where}: not in models.json")
                    continue
                if "criteria" not in entry:
                    problems.append(f"{where}: no 'criteria' key")
                    continue

                given = entry["criteria"]
                missing = set(wanted) - set(given)
                extra = set(given) - set(wanted)
                if missing:
                    problems.append(f"{where}: missing criteria — {', '.join(sorted(missing))}")
                if extra:
                    problems.append(f"{where}: criteria not in the rubric — {', '.join(sorted(extra))}")
                if missing or extra:
                    continue

                criteria, bad = {}, False
                for cid, value in given.items():
                    verdict, evidence = (value if isinstance(value, list) else (value.get("verdict"), value.get("evidence")))
                    if verdict not in VERDICT_VALUES:
                        problems.append(f"{where} / {cid}: verdict must be pass, partial or fail (got '{verdict}')")
                        bad = True
                        continue
                    if not (evidence or "").strip():
                        problems.append(f"{where} / {cid}: no evidence given")
                        bad = True
                        continue
                    criteria[cid] = {"verdict": verdict, "evidence": evidence.strip()}
                if bad:
                    continue

                total = sum(wanted.values())
                got = sum(wanted[c] * VERDICT_VALUES[criteria[c]["verdict"]] for c in criteria)
                scores["scores"].setdefault(tid, {})[name] = {
                    "adherence": round(100 * got / total, 1),
                    "criteria": criteria,
                    "summary": (entry.get("summary") or "").strip(),
                    "judged_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                }
                written += 1

    if problems:
        print("Nothing written — fix these first:\n", file=sys.stderr)
        for msg in problems:
            print("  " + msg, file=sys.stderr)
        return 1

    scores["rubric_version"] = rb["version"]
    scores["judge_model"] = JUDGE
    scores["generated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")

    if args.dry_run:
        print(f"{written} judgement(s) would be written. Nothing changed (--dry-run).")
        return 0

    RESULTS.mkdir(parents=True, exist_ok=True)
    tmp = SCORES_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(scores, indent=2, sort_keys=True) + "\n")
    tmp.replace(SCORES_PATH)
    print(f"{written} judgement(s) merged into {SCORES_PATH.relative_to(TOOLS.parent)}")
    return 0


# ---------------------------------------------------------------- status

def cmd_status(args) -> int:
    rb, roster = rubrics(), models()
    scores = load(SCORES_PATH).get("scores", {}) if SCORES_PATH.exists() else {}
    ratings = load(RATINGS_PATH).get("ratings", {}) if RATINGS_PATH.exists() else {}

    if SCORES_PATH.exists():
        stored = load(SCORES_PATH).get("rubric_version")
        if stored != rb["version"]:
            print(f"warning: scores.json was graded against rubric v{stored}, "
                  f"rubrics.json is now v{rb['version']} — re-grade for comparable numbers.\n")

    print(f"{'task':<5} {'criteria':>8} {'scored':>8} {'rated':>7}   missing")
    for t in rb["tasks"]:
        done = scores.get(t["id"], {})
        rated = ratings.get(t["id"], {})
        gap = [m["name"] for m in roster if m["name"] not in done]
        print(f"{t['id']:<5} {len(t['criteria']):>8} {len(done):>4}/{len(roster):<3} {len(rated):>3}/{len(roster):<3}   "
              + (", ".join(gap) if gap else "—"))

    total = len(rb["tasks"]) * len(roster)
    ns = sum(len(v) for v in scores.values())
    nr = sum(len(v) for v in ratings.values())
    print(f"\n{ns}/{total} scored · {nr}/{total} rated")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("prep", help="build side-by-side and contact sheets for judging")
    p.add_argument("--task", action="append", help="task id (t1..t5); repeatable, default all")
    p.add_argument("--out", help="output directory (default tools/eval/sheets)")
    p.add_argument("--height", type=int, default=760, help="panel height in px (default 760)")
    p.add_argument("--no-contact", action="store_true", help="skip the per-task contact sheet")
    p.set_defaults(func=cmd_prep)

    p = sub.add_parser("tally", help="validate verdicts and write scores.json")
    p.add_argument("verdicts", nargs="+", help="one or more verdict JSON files")
    p.add_argument("--dry-run", action="store_true", help="validate only, write nothing")
    p.set_defaults(func=cmd_tally)

    p = sub.add_parser("status", help="what is scored and rated so far")
    p.set_defaults(func=cmd_status)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
