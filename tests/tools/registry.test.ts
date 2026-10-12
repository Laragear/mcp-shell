import { describe, expect, it } from "vitest";
import { BUILTIN_TOOLS, flattenTools } from "../../src/tools/index.js";
import { loadConfigFor, toolsFor } from "../helpers.js";

function oneTool(text: string) {
  const { tools } = toolsFor(text);
  return tools[0];
}

describe("tool generation", () => {
  it("names tools deterministically and suffixes collisions", () => {
    const { tools } = toolsFor(
      "my group:\n  commands:\n    - label: Run It!\n      command: echo\n    - label: Run It!\n      command: echo\n",
    );
    expect(tools.map((t) => t.schema.name)).toEqual(["my_group__run_it", "my_group__run_it_2"]);
  });

  it("generates the right input schema per args mode", () => {
    const { tools } = toolsFor(
      [
        "g:",
        "  commands:",
        "    - label: Free",
        "      command: echo",
        "      args: true",
        "    - label: Named",
        "      command: echo",
        "      args:",
        "        - name: who",
        "          required: true",
        "        - name: punct",
        "          default: '!'",
        "    - label: ExplicitFalse",
        "      command: echo",
        "      args: false",
        "    - label: None",
        "      command: echo",
      ].join("\n"),
    );
    const [free, named, explicitFalse, none] = tools.map((t) => t.schema.inputSchema);
    expect(free.properties.args).toBeTruthy();
    expect(named.required).toEqual(["who"]);
    expect(named.properties.punct.description).toBeTruthy();
    expect(explicitFalse.properties).toEqual({});
    expect(none.properties).toEqual({});
  });

  it("always exposes the two read-only built-ins and the two proposal tools", () => {
    const cfg = loadConfigFor("g:\n  commands:\n    - label: A\n      command: echo\n");
    const names = flattenTools(cfg.groups, cfg.defaults).map((t) => t.schema.name);
    for (const b of BUILTIN_TOOLS) expect(names).toContain(b.schema.name);
    expect(BUILTIN_TOOLS.map((b) => b.schema.name)).toEqual([
      "list_commands",
      "config_template",
      "config_schema",
      "save_command",
      "remove_command",
    ]);
    for (const b of BUILTIN_TOOLS.filter((x) =>
      ["list_commands", "config_template", "config_schema"].includes(x.schema.name),
    )) {
      expect(b.schema.annotations.readOnlyHint).toBe(true);
      expect(b.schema.annotations.destructiveHint).toBe(false);
      expect(Object.keys(b.schema.inputSchema.properties)).toHaveLength(0);
    }
    const save = BUILTIN_TOOLS.find((b) => b.schema.name === "save_command");
    if (!save) throw new Error("save_command built-in missing");
    expect(save.schema.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(Object.keys(save.schema.inputSchema.properties)).toContain("command");
    expect(save.schema.inputSchema.required).toEqual(["group", "label", "command"]);
    const remove = BUILTIN_TOOLS.find((b) => b.schema.name === "remove_command");
    if (!remove) throw new Error("remove_command built-in missing");
    expect(remove.schema.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("exposes the output_to agent argument only when allow_agent", () => {
    const enabled = flattenTools(
      {
        g: {
          commands: [
            { label: "A", command: "echo" },
            { label: "B", command: "echo", output_to: false },
          ],
        },
      },
      { output_to: { dir: "logs/", allow_agent: true } },
    );
    const [a, b] = enabled.filter((t) => !("builtin" in t.entry));
    expect(a.schema.inputSchema.properties.output_to).toBeTruthy();
    expect(a.schema.description).toContain("output_to");
    expect(b.schema.inputSchema.properties.output_to).toBeUndefined();

    const always = flattenTools({
      g: { commands: [{ label: "A", command: "echo", output_to: "logs/a.log" }] },
    });
    expect(always[0].schema.inputSchema.properties.output_to).toBeUndefined();

    const local = flattenTools({
      g: {
        commands: [{ label: "A", command: "echo", output_to: { dir: "logs/", allow_agent: true } }],
      },
    });
    expect(local[0].schema.inputSchema.properties.output_to).toBeTruthy();
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

  it("maps the nature semaphore onto hints, description and consent", () => {
    const readOnly = oneTool(
      "g:\n  commands:\n    - label: A\n      command: echo\n      nature: read_only\n",
    );
    expect(readOnly.schema.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    expect(readOnly.schema.inputSchema.properties.acknowledge_destructive).toBeUndefined();

    const destructive = oneTool(
      "g:\n  commands:\n    - label: B\n      command: echo\n      nature: destructive\n",
    );
    expect(destructive.schema.inputSchema.properties.acknowledge_destructive).toMatchObject({
      type: "boolean",
    });
    expect(destructive.schema.description).toContain("acknowledge_destructive");
    expect(destructive.schema.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });

    const normal = oneTool("g:\n  commands:\n    - label: C\n      command: echo\n");
    expect(normal.schema.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(normal.schema.inputSchema.properties.acknowledge_destructive).toBeUndefined();
  });
});

describe("tool description corners", () => {
  it("ignores blank descriptions and mentions file output only when the agent may opt in", () => {
    const blank = flattenTools({
      g: { commands: [{ label: "A", command: "echo", description: "  " }] },
    }).find((t) => !("builtin" in t.entry));
    if (!blank) throw new Error("no declared tool generated");
    expect(blank.schema.title).toBe("A");

    const fixed = toolsFor(
      "g:\n  commands:\n    - label: A\n      command: echo\n      output_to: out.txt\n",
    ).tools[0];
    expect(fixed.schema.description).not.toContain("You may pass output_to");
  });
});

it("describes multiple placeholders with the plural", () => {
  const multi = toolsFor(
    [
      "g:",
      "  commands:",
      "    - label: M",
      "      command: cp {src} {dst}",
      "      args:",
      "        - name: src",
      "          required: true",
      "        - name: dst",
      "          required: true",
    ].join("\n"),
  ).tools[0];
  expect(multi.schema.description).toContain("placeholders in the command line");
});
