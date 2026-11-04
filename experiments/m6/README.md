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
