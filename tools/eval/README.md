# Evaluation workflow

Two scores per image, produced by whoever is best at judging them, kept in
separate files so neither can quietly absorb the other:

| | Produced by | Lives in | Question it answers |
|---|---|---|---|
| **Adherence** 0–100 | Claude, reading the images in-session | `../eval_results/scores.json` | Did the output do what the instruction asked? |
| **Quality** 1–5 | You, in the Judging panel on the page | `../eval_results/ratings.json` | Is it any good? |

There is **no API client and no key to set**. Claude reads the comparison sheets
directly and grades them against the rubric; `evalkit.py` only does the two jobs
a program does better than a person looking at pictures — building the sheets,
and turning verdicts into arithmetic.

The split matters. Judging adherence means checking whether the fins actually
changed and whether anything else moved — tedious, mechanical, and exactly the
sort of thing that gets waved through as "PASS" when one letter has to carry the
whole verdict. Judging quality means deciding whether you would put the image in
front of a client. Neither judgement should be allowed to contaminate the other,
which is what the old single PASS/PART/FAIL was doing.

The page plots them against each other above the leaderboard: adherence on x,
quality on y. Top-right is the frontier. Bottom-right is a model that follows
orders and looks flat; top-left is one that makes a lovely picture of a building
you did not design.

## Files

```
eval/
├── rubrics.json      # the 5 tasks, each decomposed into weighted criteria — source of truth
├── models.json       # model name -> image filename slug
├── evalkit.py        # prep | tally | status
├── requirements.txt  # Pillow, for the sheets
└── sheets/           # generated, gitignored
eval_results/
├── scores.json       # written by `tally`: per-criterion verdicts + adherence
└── ratings.json      # hand-entered: quality 1-5, exported from the page
```

## The loop

**1. Build the sheets.**

```bash
pip install -r requirements.txt
python evalkit.py prep --task t4
```

Each source/output pair becomes one side-by-side frame, plus a contact sheet of
all 13 outputs per task. Judging a material swap or a constrained zoom means
comparing against the source — putting both in a single frame makes that one
look instead of two, and catches things that are invisible when the images are
viewed apart: bleed into an adjacent surface, a camera that shifted slightly, a
roofline that quietly changed.

**2. Grade.** Claude reads `sheets/<task>/_contact.jpg` for orientation, then
each per-model sheet, and writes verdicts against every criterion in the rubric.
One task at a time — holding a single rubric across 13 models keeps the bar
consistent, which is the whole point of having a rubric.

**3. Tally.**

```bash
python evalkit.py tally verdicts-t4.json
```

Validates every criterion id against the rubric, rejects an unknown model, a bad
verdict value or a missing line of evidence, applies the weights, and merges the
result into `scores.json`. It writes nothing at all if anything fails to
validate, so a partial run cannot leave half-graded state behind. Add
`--dry-run` to check without writing.

**4. Rate quality.** Open the page, go to **Judging**. It steps through every
image with the source alongside, the instruction, and the per-criterion verdicts
already filled in. You set 1–5 and move on; progress is kept in `localStorage`.
**Export ratings.json** when done and commit it to `eval_results/`.

`python evalkit.py status` shows what is scored and rated, and what is left.

## Verdict file format

One or more tasks per file. Verdicts are `pass` / `partial` / `fail`, each with
a line of concrete visual evidence:

```json
{
  "t4": {
    "FLUX.2 Max": {
      "summary": "Both swaps executed, but the treatment spread well beyond the specified volume.",
      "criteria": {
        "geometry":          ["pass", "Massing, camera and framing match the source exactly."],
        "swap_fins":         ["pass", "The right-hand fin volume is now iridescent perforated metal."],
        "swap_signage_wall": ["pass", "Signage wall reads as hot-pink glossy plastic."],
        "no_collateral":     ["fail", "Iridescence has spread across three further podium volumes that were bronze and white in the source."],
        "lettering":         ["partial", "SIGNAGE lettering survives but is re-typeset."],
        "lighting":          ["pass", "Daylight and shadow direction preserved."]
      }
    }
  }
}
```

Weights come from `rubrics.json`: 3 = a hard constraint the instruction states
outright, 2 = an explicit requested attribute, 1 = a supporting detail.
Adherence is `100 × Σ(weight × value) / Σ(weight)` with pass 1.0, partial 0.5,
fail 0.0.

## Adding a model

1. Drop `<slug>.jpg` into each `eval_results/test*/images/`.
2. Add it to `models.json` **and** to the `SLUG` map in
   `vizai-model-eval-framework.html` (the page still carries its own copy).
3. `python evalkit.py prep`, grade it, `tally`.
4. Rate it in the Judging panel and re-export.

## Changing a rubric

Bump `version` in `rubrics.json`. `status` then warns that `scores.json` was
graded against an older rubric. Re-grade so every model is judged against the
same bar — scores from different rubric versions are not comparable, which is
why the version is recorded.
