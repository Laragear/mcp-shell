import { describe, expect, it } from "vitest";
import { emitCommand, yamlScalar } from "../../src/report/yaml.js";
import { emitGroupTemplate } from "../../src/report/group.js";

describe("yamlScalar", () => {
  it("quotes values that are not plain YAML scalars", () => {
    expect(yamlScalar("plain")).toBe("plain");
    expect(yamlScalar("has: colon")).toBe("'has: colon'");
    expect(yamlScalar("")).toBe("''");
    expect(yamlScalar("42")).toBe("'42'");
    expect(yamlScalar("true")).toBe("'true'");
    expect(yamlScalar(" padded ")).toBe("' padded '");
    expect(yamlScalar("it's")).toBe("'it''s'");
  });
});

it("emits fallbacks for a command without label or command", () => {
  const out: string[] = [];
  emitCommand(out, {});
  const text = out.join("\n");
  expect(text).toContain("label: New command");
  expect(text).toContain("command: echo fill-me-in");
});

it("emits the read_only and destructive hints as configured", () => {
  const text = emitGroupTemplate("g", {
    commands: [{ label: "A", command: "echo", read_only: true, destructive: true }],
  }).join("\n");
  expect(text).toContain("# read_only: true");
  expect(text).toContain("# destructive: true");
});
