# Evaluation workflow

Two scores per image, produced by whoever is best at judging them, kept in
separate files so neither can quietly absorb the other:

| | Produced by | Lives in | Question it answers |
|---|---|---|---|
| **Adherence** 0–100 | `score.py`, a Claude vision judge | `../eval_results/scores.json` | Did the output do what the instruction asked? |
| **Quality** 1–5 | You, in the Judging panel on the page | `../eval_results/ratings.json` | Is it any good? |

The judge is told explicitly not to reward a beautiful image on a preservation
criterion, or punish an ugly one that obeyed. Taste is not its job. Conversely
you never have to squint at fin proportions to decide whether swap 1 happened —
that is already graded, with evidence.

The page plots the two against each other above the leaderboard: adherence on x,
quality on y. Top-right is the frontier. Bottom-right is a model that follows
orders and looks flat; top-left is one that makes a lovely picture of a building
you did not design.

## Files

```
eval/
├── rubrics.json      # the 5 tasks, each decomposed into weighted criteria — source of truth
├── models.json       # model name -> image filename slug
├── score.py          # vision judge -> scores.json
└── requirements.txt
eval_results/
├── scores.json       # generated: per-criterion verdicts + adherence
└── ratings.json      # hand-entered: quality 1-5, exported from the page
```

## Running the judge

```bash
pip install -r requirements.txt
export ANTHROPIC_API_KEY=...        # or run: ant auth login
python score.py
```

It skips anything already in `scores.json`, so it is safe to re-run — and it
writes through after every judgement, so an interrupted run keeps the work it
already paid for.

```bash
python score.py --task t5                    # one task
python score.py --model "FLUX.2 Max"         # one model, every task
python score.py --force                      # re-score, ignoring existing results
python score.py --dry-run                    # list the work without calling the API
```

A full run is 65 judgements (13 models × 5 tasks) at `--concurrency 4`.

## Rating by hand

Open the page, go to **Judging**. It steps through every image with the source
alongside, the instruction, and the judge's per-criterion verdicts already
filled in on the left. You set 1–5 and move on; progress is kept in
`localStorage` as you go. **Export ratings.json** when done and commit the file
to `eval_results/`.

## Adding a model

1. Drop `<slug>.jpg` into each `eval_results/test*/images/`.
2. Add it to `models.json` **and** to the `SLUG` map in
   `vizai-model-eval-framework.html` (the page still carries its own copy).
3. `python score.py --model "<name>"`.
4. Rate it in the Judging panel and re-export.

## Changing a rubric

Bump `version` in `rubrics.json`. `score.py` notices that `scores.json` was
built against an older rubric and warns; re-run with `--force` so every model is
judged against the same bar. Scores from different rubric versions are not
comparable, which is the whole reason the version is recorded.
