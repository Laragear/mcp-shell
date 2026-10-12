import { describe, expect, it } from "vitest";
import { matchOutput } from "../../src/runner/index.js";

describe("matchOutput", () => {
  it("checks contains and not_contains in scalar and list form", () => {
    expect(matchOutput("all good", { contains: "good" })).toEqual({ ok: true, reasons: [] });
    expect(matchOutput("all good", { contains: ["good", "great"] }).ok).toBe(false);
    expect(matchOutput("all good", { contains: "great" }).reasons).toEqual([
      'does not contain "great"',
    ]);
    expect(matchOutput("has FAIL here", { not_contains: "FAIL" }).reasons).toEqual([
      'contains forbidden "FAIL"',
    ]);
    expect(matchOutput("clean", { not_contains: ["nope", "nada"] })).toEqual({
      ok: true,
      reasons: [],
    });
  });

  it("checks regex and not_regex, reporting invalid patterns", () => {
    expect(matchOutput("12 passed", { regex: "\\d+ passed" })).toEqual({ ok: true, reasons: [] });
    expect(matchOutput("nothing", { regex: "\\d+" }).reasons[0]).toContain("does not match regex");
    expect(matchOutput("12 passed", { not_regex: "passed" }).reasons[0]).toContain(
      "matches forbidden regex",
    );
    expect(matchOutput("clean", { not_regex: "zzz" }).ok).toBe(true);
    expect(matchOutput("x", { regex: "[" }).reasons[0]).toContain("invalid regex");
    expect(matchOutput("x", { not_regex: "(" }).reasons[0]).toContain("invalid not_regex");
  });
});

describe("matchOutput", () => {
  it("applies contains/not_contains/regex/not_regex with AND semantics", () => {
    expect(matchOutput("all 12 tests passed", { contains: "passed" })).toEqual({
      ok: true,
      reasons: [],
    });
    const r = matchOutput("3 FAILURES", { not_contains: ["FAILURES"], regex: ["\\d+ passed"] });
    expect(r.ok).toBe(false);
    expect(r.reasons).toHaveLength(2);
    expect(matchOutput("ok", { regex: ["[unclosed"] } as any).ok).toBe(false);
    expect(matchOutput("x", {})).toEqual({ ok: true, reasons: [] });
  });
});
