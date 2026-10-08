import { describe, expect, it } from "vitest";
import {
  buildCommandline,
  BUILTIN_TOOLS,
  flattenTools,
  previewCommandline,
} from "../src/tools/index.js";
import { loadConfigFor, toolsFor } from "./helpers.js";

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

describe("buildCommandline", () => {
  it("shell-quotes free arguments (no injection)", () => {
    const { tools } = toolsFor(
      "g:\n  commands:\n    - label: E\n      command: echo\n      args: true\n",
    );
    expect(buildCommandline(tools[0].entry as any, ["safe", "bad; rm -rf /"])).toBe(
      "echo 'safe' 'bad; rm -rf /'",
    );
  });

  it("keeps order, applies defaults and enforces required named args", () => {
    const { tools } = toolsFor(
      [
        "g:",
        "  commands:",
        "    - label: E",
        "      command: run",
        "      args:",
        "        - name: a",
        "          required: true",
        "        - name: b",
        "          default: x",
        "        - name: c",
      ].join("\n"),
    );
    const entry = tools[0].entry as any;
    expect(buildCommandline(entry, { a: "1" })).toBe("run '1' 'x'");
    expect(buildCommandline(entry, { a: "1", b: "2", c: "3" })).toBe("run '1' '2' '3'");
    expect((buildCommandline(entry, {}) as any).error).toMatch(/Missing required argument "a"/);
    expect((buildCommandline(entry, { a: "1", zz: "9" }) as any).error).toMatch(
      /Unknown argument "zz"/,
    );
  });

  it("glues prefix and suffix around quoted values and omits absent optionals", () => {
    const { tools } = toolsFor(
      [
        "g:",
        "  commands:",
        "    - label: Docker",
        "      command: docker run img",
        "      args:",
        "        - name: memory",
        '          prefix: "--memory "',
        "        - name: mode",
        '          suffix: ":rw"',
        "        - name: plain",
        "          required: true",
      ].join("\n"),
    );
    const entry = tools[0].entry as any;
    expect(buildCommandline(entry, { plain: "x" })).toBe("docker run img 'x'");
    expect(buildCommandline(entry, { plain: "x", memory: "512m" })).toBe(
      "docker run img --memory '512m' 'x'",
    );
    expect(buildCommandline(entry, { plain: "x", mode: "rw" })).toBe("docker run img 'rw':rw 'x'");
    expect(buildCommandline(entry, { plain: "x", memory: "512m", mode: "rw" })).toBe(
      "docker run img --memory '512m' 'rw':rw 'x'",
    );
  });

  it("fills placeholders in place and appends leftovers", () => {
    const { tools } = toolsFor(
      [
        "g:",
        "  commands:",
        "    - label: Checkout",
        "      command: git checkout {branch} --",
        "      args:",
        "        - name: branch",
        "          required: true",
        "        - name: verbose",
        "          default: --quiet",
      ].join("\n"),
    );
    const entry = tools[0].entry as any;
    expect(buildCommandline(entry, { branch: "main" })).toBe("git checkout 'main' -- '--quiet'");
    expect(buildCommandline(entry, { branch: "a b", verbose: "-v" })).toBe(
      "git checkout 'a b' -- '-v'",
    );
    expect((buildCommandline(entry, {}) as any).error).toMatch(
      /Missing required argument "branch"/,
    );
    expect(previewCommandline(entry)).toMatch(/git checkout '<branch>' -- 'verbose=--quiet'/);
  });

  it("supports mid-command placeholders", () => {
    const { tools } = toolsFor(
      [
        "g:",
        "  commands:",
        "    - label: Ns",
        "      command: kubectl --namespace {ns} get pods",
        "      args:",
        "        - name: ns",
        "          required: true",
      ].join("\n"),
    );
    expect(buildCommandline(tools[0].entry as any, { ns: "prod" })).toBe(
      "kubectl --namespace 'prod' get pods",
    );
  });

  it("keeps the parse stage out of the command line (the runner pipes it)", () => {
    const { tools } = toolsFor(
      "g:\n  commands:\n    - label: P\n      command: cat f | sort\n      pipe: wc -l\n",
    );
    expect(previewCommandline(tools[0].entry as any)).toBe("cat f | sort | wc -l");
    expect(buildCommandline(tools[0].entry as any, undefined)).toBe("cat f | sort");
  });
});
