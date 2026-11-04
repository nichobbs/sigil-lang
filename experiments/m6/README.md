# M6: seeded-defect review (Haiku, one run per cell)

`defects.json` holds one defect per task (A1-A4, B1-B4) as matched edits to the human-written reference programs in both languages; `make.py` builds the clean/defective sets and `prepare.py` builds the reviewer workspaces (a single `REVIEW.md` per run, same prompt; Sigil gets `verify --fast`, TS gets `check.sh`). `score.py` collects `review.json`. Raw results are in `results.jsonl`.

Design: 8 defects per language plus 2 clean controls (A3, B1) per language, 20 reviewer runs. Defect categories: leak (A1, B3), authorisation (A4, B1), audit (A3, B2), validation (B4), overflow (A2). The same hidden cases fail on the TS and Sigil version of each defect (identical failure counts), so the defects are matched.

Findings (post-v1 language, tasks no longer blind, Haiku, n=1 per cell):
- A2 is an invalid defect: its README says "a Credit never has to be clamped", so an unclamped credit does not violate the spec at the scorer's inputs. Both reviewers rightly did not report it as a spec violation (the Sigil reviewer saw six failing properties from the unclamped range and dismissed them for that reason). It is excluded from the denominator. No overflow defect was therefore tested.
- 7 valid defects: both arms found 7 of 7. Clean controls: no false positives in either arm (A3, B1). Ceiling effect: the programs are 40-80 lines, so a reviewer finds these by reading. TS reviewers made 2 tool calls (read the brief, write the review) and ran no tools. The 20-point criterion for M6 is not met because both arms are at 100%; the design is too easy to discriminate, not evidence of equality on subtle defects.
- Tool signal (Sigil): `verify --fast` failed on all 8 defective programs (leak: E-flow or event-shape mismatch; the rest: scenario or property failures). So all 8 were "caught by tool" before any judgement; but the TS side has no equivalent executable spec in this protocol (ported scenario tests were not provided), which favours Sigil's tool catch rate and is a protocol asymmetry to resolve before reporting.
- Cost: Sigil reviewers used about 98k tokens and 3-4 calls; TS reviewers about 85-90k and 2-4 calls (about +15%, dominated by the language spec in the brief).
- Sigil finding: B3's defect (an extra field on an audit event type that the human glossary also constructs) makes `verify` crash with a raw TypeError (constructor arity mismatch in the glossary is not diagnosed). The reviewer still caught the defect by reading. To fix: report E-arity for constructors in glossaries instead of crashing.

Next: harder defects (subtle, cross-function, larger programs), TS scenario tests ported from `intent.feature`, and a second model.

## Harder round (defects_hard.json, results_hard.jsonl)

Eight subtle defects, each a violation of a stated spec rule, matched across languages (identical hidden-case failure counts; B2's defect fails no hidden case in either language): A1 80% floor rounded down; A2 a Fee adds to the amount spent; A3 burst flag not recorded; A4 exact approval limit needs approval; B1 Gone checked before authorisation; B2 fallback channel also on attempt 3; B3 earlier refunds ignored; B4 DuplicateInBatch checked before AlreadyImported. Reviewers are told to run the tooling at least once. Haiku, one run per cell, 8 defective plus 2 clean controls (A1, B3) per language.

| | defects found | clean controls flagged | avg tokens | avg tool calls |
|---|---|---|---|---|
| Sigil | 7 / 8 (missed B4) | 0 / 2 | 98.5k | 3.0 |
| TypeScript | 8 / 8 | 0 / 2 | 87.7k | 4.4 |

- No advantage for Sigil: TS found everything and Sigil missed one. With n=1 per cell the difference is noise, but there is certainly no 20-point gain.
- Sigil `verify --fast` detected only 4 of the 8 (A1 floor property, A2 example, B1, B3); A3, A4, B2 and B4 came back clean, because the visible examples and properties do not exercise those paths. The reviewer found A3, A4 and B2 by reading despite a clean tool run; for B4 the reviewer reported no defect after a clean run (possible anchoring on the clean `verify`, not shown).
- TS reviewers wrote and ran their own probe tests in several runs (4 to 6 calls), which is how they confirmed A3, A4 and B1.
- Cost: Sigil about 12% more tokens per review (the language spec is in every brief).
- Conclusion for the pre-registered criterion: M6 (at least 20 points higher for Sigil with tool catches) is not met on either round. The tool signal helps when the spec's executable examples cover the defect (leaks, authorisation, audit in round one) and is silent when they do not.

## Fair TS arm: ported scenario tests (results_hard_scenarios.jsonl)

The hard round gave Sigil reviewers executable examples (`verify --fast`) but TS reviewers only the examples as prose. This rerun gives the TS reviewers the same examples as ready-made vitest cases (`scenarios.test.ts`, generated from `intent.feature` by `experiments/export-scenarios.ts`; `./check.sh` runs them). Same eight hard defects and the two clean controls, Haiku, n=1, post-v1, not blind.

| | defects found | clean controls flagged | avg tokens | avg tool calls |
|---|---|---|---|---|
| TypeScript, prose examples (before) | 8 / 8 | 0 / 2 | 87.7k | 4.4 |
| TypeScript, ported scenario tests | 8 / 8 | 0 / 2 | 76.9k (defects) | 3.9 |
| Sigil (before) | 7 / 8 | 0 / 2 | 98.5k | 3.0 |

- The ported scenarios alone fail on 2 of the 8 defective programs (A2, A3); the rest were found by reading the code and the reviewer's own probe tests. Properties and the `Always` rules were not ported.
- Giving TS the same executable examples did not change detection (8/8 either way) and lowered cost. The fair comparison therefore still shows no Sigil advantage on review at this program size.
