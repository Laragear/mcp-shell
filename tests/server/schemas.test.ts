import { describe, expect, it } from "vitest";
import { argValuesFor, zodInput } from "../../src/server/schemas.js";

describe("zod input schemas", () => {
  it("declares required and optional named arguments", () => {
    const entry = {
      args: {
        mode: "named" as const,
        specs: [
          { name: "must", description: "required one", required: true },
          { name: "maybe", description: "optional one", required: false },
        ],
      },
    } as any;
    const schema = zodInput(entry, false);
    const parsed = schema.parse({ must: "x", junk: true });
    expect(parsed).toEqual({ must: "x", maybe: undefined });
    expect(() => schema.parse({})).toThrow();
  });

  it("declares free args and the agent output_to only when allowed", () => {
    const free = zodInput({ args: { mode: "free" } } as any, true);
    expect(free.parse({ args: ["a"], output_to: "ok.txt" })).toEqual({
      args: ["a"],
      output_to: "ok.txt",
    });
    expect(() => free.parse({ args: ["a"], output_to: "bad name!.txt" })).toThrow();

    const strict = zodInput({ args: { mode: "none" } } as any, false);
    expect(strict.parse({ whatever: 1 })).toEqual({});
  });

  it("marshals arguments per argument mode", () => {
    const free = { args: { mode: "free" as const } } as any;
    expect(argValuesFor(free, { args: ["x"] })).toEqual(["x"]);
    const named = { args: { mode: "named" as const, specs: [] } } as any;
    expect(argValuesFor(named, { a: 1, output_to: true })).toEqual({ a: 1 });
    const none = { args: { mode: "none" as const } } as any;
    expect(argValuesFor(none, { a: 1 })).toEqual({});
  });
});
