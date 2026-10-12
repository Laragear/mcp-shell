import { describe, expect, it } from "vitest";
import { argMode, buildCommandline, flattenTools, previewCommandline } from "../src/tools/index.js";
import { slug } from "../src/support.js";
import { toolsFor } from "./helpers.js";

/** The declared tool (built-ins filtered) for a config text. */
function oneTool(text: string) {
  const { tools } = toolsFor(text);
  return tools[0];
}

describe("previewCommandline", () => {
  it("marks free args, named placeholders and defaults", () => {
    const free = oneTool(
      "g:\n  commands:\n    - label: F\n      command: echo\n      args: true\n",
    );
    expect(previewCommandline(free.entry)).toBe("echo '<free args…>'");

    const named = oneTool(
      [
        "g:",
        "  commands:",
        "    - label: N",
        "      command: cp {src}",
        "      args:",
        "        - name: src",
        "          required: true",
      ].join("\n"),
    );
    expect(previewCommandline(named.entry)).toBe("cp '<src>'");

    const defaulted = oneTool(
      [
        "g:",
        "  commands:",
        "    - label: D",
        "      command: cp {src}",
        "      args:",
        "        - name: src",
        "          default: file.txt",
      ].join("\n"),
    );
    expect(previewCommandline(defaulted.entry)).toBe("cp 'src=file.txt'");

    const optional = oneTool(
      [
        "g:",
        "  commands:",
        "    - label: O",
        "      command: cp {src}",
        "      args:",
        "        - name: src",
      ].join("\n"),
    );
    expect(previewCommandline(optional.entry)).toBe("cp '[src]'");

    const appended = oneTool(
      [
        "g:",
        "  commands:",
        "    - label: P",
        "      command: echo",
        "      args:",
        "        - name: extra",
        "          required: true",
      ].join("\n"),
    );
    expect(previewCommandline(appended.entry)).toBe("echo '<extra>'");

    const none = oneTool("g:\n  commands:\n    - label: X\n      command: echo\n");
    expect(previewCommandline(none.entry)).toBe("echo");

    const piped = oneTool(
      ["g:", "  commands:", "    - label: P", "      command: echo", "      pipe: tail -1"].join(
        "\n",
      ),
    );
    expect(previewCommandline(piped.entry)).toBe("echo | tail -1");
  });
});

describe("buildCommandline", () => {
  it("quotes free-form values and quotes named values into placeholders", () => {
    const free = oneTool(
      "g:\n  commands:\n    - label: F\n      command: echo\n      args: true\n",
    );
    expect(buildCommandline(free.entry, ["a b", "c"])).toBe("echo 'a b' 'c'");
    expect(buildCommandline(free.entry, "not-a-list")).toBe("echo");

    const named = oneTool(
      [
        "g:",
        "  commands:",
        "    - label: N",
        "      command: echo {msg} tail",
        "      args:",
        "        - name: msg",
        "          required: true",
      ].join("\n"),
    );
    expect(buildCommandline(named.entry, { msg: "two words" })).toBe("echo 'two words' tail");
    // A named argument without a placeholder is appended in declared order.
    const appended = oneTool(
      [
        "g:",
        "  commands:",
        "    - label: A",
        "      command: echo",
        "      args:",
        "        - name: extra",
        "          default: fell-back",
      ].join("\n"),
    );
    expect(buildCommandline(appended.entry, { extra: "x" })).toBe("echo 'x'");
    expect(buildCommandline(appended.entry, {})).toBe("echo 'fell-back'");
  });

  it("rejects unknown named arguments and missing required ones", () => {
    const named = oneTool(
      [
        "g:",
        "  commands:",
        "    - label: N",
        "      command: echo {msg}",
        "      args:",
        "        - name: msg",
        "          required: true",
      ].join("\n"),
    );
    expect(buildCommandline(named.entry, { nope: 1 })).toEqual({
      error: 'Unknown argument "nope". Allowed: msg.',
    });
    expect(buildCommandline(named.entry, {})).toEqual({
      error: 'Missing required argument "msg".',
    });
  });

  it("rejects a command that becomes empty after substitution", () => {
    const named = oneTool(
      [
        "g:",
        "  commands:",
        "    - label: N",
        "      command: '{msg}'",
        "      args:",
        "        - name: msg",
      ].join("\n"),
    );
    expect(buildCommandline(named.entry, {})).toEqual({
      error: "Command is empty after argument substitution.",
    });
    // An optional placeholder with no value just leaves nothing in its place.
    const echo = oneTool(
      [
        "g:",
        "  commands:",
        "    - label: M",
        "      command: echo {msg}",
        "      args:",
        "        - name: msg",
      ].join("\n"),
    );
    expect(buildCommandline(echo.entry, {})).toBe("echo ");
  });
});

describe("flattenTools edge cases", () => {
  it("skips malformed groups and commands without throwing", () => {
    const tools = flattenTools({
      bad: null,
      empty: { description: "no commands" },
      junk: {
        commands: [
          null,
          "x",
          { label: "A" },
          { label: "B", command: "  " },
          { label: "C", command: "echo" },
        ],
      },
    } as any);
    expect(tools.map((t) => t.schema.name)).toContain("junk__c");
    expect(tools.filter((t) => !("builtin" in t.entry))).toHaveLength(1);
  });

  it("suffixes colliding names and titles come from the label", () => {
    const tools = flattenTools({
      g: {
        commands: [
          { label: "A", command: "echo" },
          { label: "A", command: "echo" },
        ],
      },
    });
    const declared = tools.filter((t) => !("builtin" in t.entry));
    expect(declared.map((t) => t.schema.name)).toEqual(["g__a", "g__a_2"]);
    expect(declared[0].schema.title).toBe("A");
    expect(declared[1].schema.title).toBe("A");
  });

  it("reports a command that is both read_only and destructive and gates it as destructive", () => {
    const { tools, cfg } = toolsFor(
      "g:\n  commands:\n    - label: A\n      command: echo\n      read_only: true\n      destructive: true\n",
    );
    expect(
      cfg.issues.some((i) => i.includes('"read_only" and "destructive" cannot both be true')),
    ).toBe(true);
    expect(tools).toHaveLength(1);
    expect(tools[0].schema.inputSchema.properties.acknowledge_destructive).toMatchObject({
      type: "boolean",
    });
  });

  it("adds the consent argument and description to a destructive tool", () => {
    const tool = oneTool(
      "g:\n  commands:\n    - label: A\n      command: echo\n      destructive: true\n",
    );
    expect(tool.schema.inputSchema.properties.acknowledge_destructive).toMatchObject({
      type: "boolean",
    });
    expect(tool.schema.description).toContain("acknowledge_destructive");
    expect(tool.schema.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("keeps read_only and destructive flags without conflicts as plain annotations", () => {
    const tool = oneTool(
      "g:\n  commands:\n    - label: A\n      command: echo\n      read_only: true\n",
    );
    expect(tool.schema.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    expect(tool.schema.inputSchema.properties.acknowledge_destructive).toBeUndefined();
  });
});

describe("argMode", () => {
  it("classifies args: true, named lists and everything else", () => {
    expect(argMode({ args: true } as any).mode).toBe("free");
    const named = argMode({
      args: [{ name: "a" }, { nope: true }, { name: "b", default: 3 }],
    } as any);
    expect(named.mode).toBe("named");
    expect(named.specs).toEqual([
      { name: "a", description: "Value for a", required: false, default: undefined },
      { name: "b", description: "Value for b", required: false, default: "3" },
    ]);
    expect(argMode({ args: false } as any).mode).toBe("none");
    expect(argMode({ args: [{ description: "no name" }] } as any).mode).toBe("none");
    expect(argMode({} as any).mode).toBe("none");
  });
});

describe("slug", () => {
  it("slugifies names and falls back to cmd when nothing survives", () => {
    expect(slug("Run All Tests!")).toBe("run_all_tests");
    expect(slug("///")).toBe("label");
  });
});
