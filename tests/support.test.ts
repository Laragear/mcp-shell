import { expect, it } from "vitest";
import { expandEnvVars } from "../src/support.js";

it("expands env var references against a lookup", () => {
  const ref = (n: string) => `$\{${n}}`;
  const lookup = (n: string) => ({ A: "1", B: "2" })[n];
  expect(expandEnvVars(`${ref("A")}-${ref("B")}-${ref("A")}`, lookup)).toBe("1-2-1");
  expect(expandEnvVars("no references", lookup)).toBe("no references");
  expect(expandEnvVars(`$A ${ref("C")}`, lookup)).toBe("$A ");
  expect(expandEnvVars(`${ref("1bad")} ${ref("_ok")}`, lookup)).toBe(`${ref("1bad")} `);
});
