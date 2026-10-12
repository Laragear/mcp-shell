import { describe, expect, it } from "vitest";
import { parseYaml } from "../../src/yaml/index.js";

describe("yaml parser", () => {
  it("parses nested mappings with scalars, booleans and comments", () => {
    const v = parseYaml(
      [
        "# leading comment",
        "group:",
        "  description: Runs tests  # trailing comment",
        "  enabled: true",
        "  count: 3",
        "  env:",
        "    A: hello",
      ].join("\n"),
    );
    expect(v).toEqual({
      group: { description: "Runs tests", enabled: true, count: 3, env: { A: "hello" } },
    });
  });

  it("parses sequences of mappings opened inline", () => {
    const v = parseYaml(
      [
        "commands:",
        "  - label: One",
        "    command: echo a",
        "  - label: Two",
        "    command: echo b",
      ].join("\n"),
    );
    expect(v).toEqual({
      commands: [
        { label: "One", command: "echo a" },
        { label: "Two", command: "echo b" },
      ],
    });
  });

  it("skips blank lines between keys and items", () => {
    const v = parseYaml(
      ["g:", "", "  commands:", "", "    - label: A", "", "      command: echo", ""].join("\n"),
    );
    expect(v).toEqual({ g: { commands: [{ label: "A", command: "echo" }] } });
  });

  it("parses flow sequences including quoted commas", () => {
    expect(parseYaml("list: [a, b]")).toEqual({ list: ["a", "b"] });
    expect(parseYaml('list: ["x, y", z]')).toEqual({ list: ["x, y", "z"] });
    expect(parseYaml("list: []")).toEqual({ list: [] });
  });

  it("parses flow mappings, empty and nested", () => {
    expect(parseYaml("env: { A: 1, B: hello }")).toEqual({ env: { A: 1, B: "hello" } });
    expect(parseYaml("empty: {}")).toEqual({ empty: {} });
    expect(parseYaml("mixed: {a: [1, 2], b: 'x, y'}")).toEqual({ mixed: { a: [1, 2], b: "x, y" } });
  });

  it("parses literal block scalars with chomping", () => {
    expect(parseYaml("cmd: |\n  echo one\n  echo two").cmd).toBe("echo one\necho two\n");
    expect(parseYaml("cmd: |-\n  echo one\n  echo two").cmd).toBe("echo one\necho two");
    expect(parseYaml("cmd: |\n  echo one\n\n  echo two").cmd).toBe("echo one\n\necho two\n");
  });

  it("parses folded block scalars", () => {
    expect(parseYaml("cmd: >\n  echo one\n  echo two").cmd).toBe("echo one echo two\n");
    expect(parseYaml("cmd: >\n  echo one\n\n  echo two").cmd).toBe("echo one\necho two\n");
    expect(parseYaml("cmd: >-\n  alpha\n  beta").cmd).toBe("alpha beta");
  });

  it("keeps special characters in quoted values", () => {
    expect(parseYaml('key: "a: b # c"')).toEqual({ key: "a: b # c" });
    expect(parseYaml("key: 'it''s'")).toEqual({ key: "it's" });
  });

  it("rejects tabs, anchors and inline block scalars with clear errors", () => {
    expect(() => parseYaml("a:\n\tb: 1")).toThrow(/tab character/);
    expect(() => parseYaml("a: &anchor 1")).toThrow(/anchors\/aliases/);
    expect(() => parseYaml("a: | text")).toThrow(/block scalars/);
  });

  it("carries a line number on parse errors", () => {
    expect(() => parseYaml("good: 1\noops")).toThrow(/line 2/);
  });
});

describe("yaml parser corners", () => {
  it("parses null-ish scalars and an empty flow value", () => {
    expect(parseYamlRaw("a: ~")).toEqual({ a: null });
    expect(parseYamlRaw("a: {x: }")).toEqual({ a: { x: null } });
  });

  it("parses a value-less key at the end of the document", () => {
    expect(parseYamlRaw("a:\n")).toEqual({ a: null });
  });

  it("rejects anchors and aliases", () => {
    expect(() => parseYamlRaw("a: &x 1")).toThrow(/anchors\/aliases/);
    expect(() => parseYamlRaw("a: *x")).toThrow(/anchors\/aliases/);
  });

  it("handles an empty block scalar body followed by a dedent", () => {
    expect(parseYamlRaw("t: |\na: 1")).toEqual({ t: "", a: 1 });
  });

  it("supports folded keep chomping", () => {
    expect(parseYamlRaw("t: >+\n  a\n")).toEqual({ t: "a\n\n" });
  });

  it("keeps blank lines between mappings and rejects non-string keys", () => {
    expect(parseYamlRaw("a: 1\n\nb: 2")).toEqual({ a: 1, b: 2 });
    expect(() => parseYamlRaw("1: x")).toThrow("mapping key must be a string");
  });

  it("parses a null value before a dedented key", () => {
    expect(parseYamlRaw("a:\nb: 1")).toEqual({ a: null, b: 1 });
  });
});

/** parseYaml with a short local alias. */
function parseYamlRaw(text: string): any {
  return parseYaml(text);
}
