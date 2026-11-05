import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import { parsePolicy, parseProgram } from "../src/parse.js";
import { parseFeature, parseGlossary, runSuite } from "../src/scenario.js";

const T = (p: string) =>
  readFileSync(new URL(`../experiments/tasks/${p}`, import.meta.url), "utf8");
const APP = T("D5-derived-open/ref/sigil/app.sigil");
const FEATURE = T("X4-spec-review-hard/base/intent.feature");
const POLICY = T("X4-spec-review-hard/base/policy.sigil");

function suite(glossary: string) {
  const prog = parseProgram(APP);
  const chk = check(prog, parsePolicy(POLICY));
  return runSuite(
    prog,
    parseFeature(FEATURE),
    parseGlossary(glossary, prog),
    chk,
  ).results;
}

describe("property generation uses literals from the property as boundary values", () => {
  it("the base glossary passes; the Q01 off-by-one at the Support cap fails with m=20000", () => {
    expect(
      suite(T("X4-spec-review-hard/base/glossary.sigil")).filter(
        (r) => r.status === "fail",
      ),
    ).toEqual([]);
    const fail = suite(T("X4-spec-review-hard/proposals/Q01.sigil")).find(
      (r) => r.status === "fail",
    );
    expect(fail?.message).toContain("m=20000");
  });
});
