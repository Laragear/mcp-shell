import { describe, expect, it } from "vitest";
import { YamlError, parseYaml } from "../../src/yaml/index.js";

/** The YamlError message of input that must fail to parse. */
function errorOf(text: string): string {
  try {
    parseYaml(text);
  } catch (e) {
    return e instanceof YamlError ? e.message : String(e);
  }
  return `no error for ${JSON.stringify(text)}`;
}

describe("yaml sequences", () => {
  it("parses scalar items with blank lines between them", () => {
    expect(parseYaml("nums:\n  - one\n\n  - two\n")).toEqual({ nums: ["one", "two"] });
  });

  it("parses a bare dash with a nested block, and a bare dash alone as null", () => {
    expect(parseYaml("a:\n  -\n    x: 1\n  -\n")).toEqual({ a: [{ x: 1 }, null] });
  });

  it("parses a block scalar as a sequence item", () => {
    expect(parseYaml("a:\n  - |\n    line one\n    line two\n")).toEqual({
      a: ["line one\nline two\n"],
    });
  });
});

describe("yaml block scalar chomping and folding", () => {
  it("clips by default, strips with |- and keeps with |+", () => {
    expect(parseYaml("t: |\n  a\n\n\n")).toEqual({ t: "a\n" });
    expect(parseYaml("t: |-\n  a\n\n\n")).toEqual({ t: "a" });
    expect(parseYaml("t: |+\n  a\n\n\n")).toEqual({ t: "a\n\n\n\n" });
  });

  it("folds > blocks into one line", () => {
    expect(parseYaml("t: >\n  a\n  b\n")).toEqual({ t: "a b\n" });
  });
});

describe("yaml flow mappings", () => {
  it("parses flow mappings into objects", () => {
    expect(parseYaml("a: {x: 1, y: two}")).toEqual({ a: { x: 1, y: "two" } });
  });

  it("rejects flow mapping entries without a colon", () => {
    expect(errorOf("a: {novalue}")).toContain('cannot parse flow mapping entry "novalue"');
  });

  it("rejects non-string flow mapping keys", () => {
    expect(errorOf("a: {1: x}")).toContain("flow mapping key must be a string");
  });
});

describe("yaml scanner corners", () => {
  it("keeps # inside a word but strips whole comments", () => {
    expect(parseYaml("a#b: 1 # trailing\n")).toEqual({ "a#b": 1 });
  });

  it("skips document markers and leading blank lines", () => {
    expect(parseYaml("\n\n---\na: 1\n")).toEqual({ a: 1 });
  });

  it("rejects unexpected content after the top-level block", () => {
    expect(errorOf("a: 1\n- stray\n")).toContain("unexpected content");
  });

  it("returns null for an empty document", () => {
    expect(parseYaml("\n\n")).toBeNull();
  });
});
