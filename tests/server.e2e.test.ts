import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTmp, withEnv } from "./helpers.js";
import { projectSlug as projectSlugOf } from "../src/config/index.js";

const tmp = makeTmp("sr-e2e-");
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

// The remaining coverage needs the compiled entrypoint (mcp/server.js),
// which `npm test` builds before running vitest.
const built = path.join(__dirname, "..", "mcp", "main.js");
const describeBuilt = fs.existsSync(built) ? describe : describe.skip;

function runBuilt(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const p = spawn(process.execPath, [built, ...args], {
      env: { ...process.env, SHELL_RUNNER_VALIDATE: "", ...env },
    });
    let stdout = "";
    let stderr = "";
    p.stdout?.on("data", (d) => (stdout += d));
    p.stderr?.on("data", (d) => (stderr += d));
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describeBuilt("compiled CLI", () => {
  it("--validate exits 1 on an invalid config and 0 on a valid one", async () => {
    const bad = path.join(tmp, "bad.yaml");
    fs.writeFileSync(bad, "g:\n  commands:\n    - command: echo\n");
    const good = path.join(tmp, "good.yaml");
    fs.writeFileSync(good, "g:\n  commands:\n    - label: A\n      command: echo\n");
    expect((await runBuilt(["--validate", bad])).code).toBe(1);
    expect((await runBuilt(["--validate", good])).code).toBe(0);
  });

  it("--template --save refuses to overwrite without --force", async () => {
    const projDir = makeTmp("sr-cli-");
    const homeDir = makeTmp("sr-home-");
    const target = path.join(
      homeDir,
      ".agents",
      "mcp-shell-runner",
      withEnv({ SHELL_RUNNER_PROJECT_DIR: projDir }, () => projectSlugOf()),
      "commands.yaml",
    );
    try {
      const env = { SHELL_RUNNER_PROJECT_DIR: projDir, SHELL_RUNNER_HOME: homeDir };
      const first = await runBuilt(["--template", "--save", "agents"], env);
      expect(first.code).toBe(0);
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.readFileSync(target, "utf8")).toContain("myproject:");
      expect((await runBuilt(["--template", "--save", "agents"], env)).code).toBe(1);
      expect((await runBuilt(["--template", "--save", "agents", "--force"], env)).code).toBe(0);
      expect((await runBuilt(["--template", "--save", "bogus"], env)).code).toBe(1);
    } finally {
      fs.rmSync(projDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("speaks JSON-RPC over stdio and cancels in-flight calls", async () => {
    const cfgPath = path.join(tmp, "e2e.yaml");
    fs.writeFileSync(
      cfgPath,
      "g:\n  commands:\n    - label: Ok\n      command: echo hello\n    - label: Slow\n      command: sleep 30\n      timeout: 20\n",
    );
    const child = spawn(process.execPath, [built], {
      env: { ...process.env, SHELL_RUNNER_CONFIG: cfgPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const responses: any[] = [];
    let buf = "";
    child.stdout?.on("data", (d) => {
      buf += d;
      let idx = buf.indexOf("\n");
      while (idx >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) responses.push(JSON.parse(line));
        idx = buf.indexOf("\n");
      }
    });
    child.stderr?.on("data", () => {});
    const write = (obj: any, waitMs: number) =>
      new Promise<void>((done) => {
        child.stdin?.write(`${JSON.stringify(obj)}\n`);
        setTimeout(done, waitMs);
      });
    const started = Date.now();
    await write(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "raw-client", version: "0.0.0" },
        },
      },
      200,
    );
    await write({ jsonrpc: "2.0", method: "notifications/initialized" }, 100);
    await write(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "g__ok", arguments: {} } },
      400,
    );
    await write(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "g__slow", arguments: {} } },
      500,
    );
    await write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 3 } }, 0);
    // fastmcp answers a cancelled request with a JSON-RPC error instead of
    // dropping it; prove the answer arrives promptly and the server stays
    // healthy.
    await new Promise((d) => setTimeout(d, 800));
    expect(responses.find((r) => r.id === 3)?.error?.code).toBe(-32603);
    await write(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "list_commands", arguments: {} },
      },
      400,
    );
    // A config edit followed by any call re-syncs the tool set; fastmcp then
    // announces the change on the wire by itself.
    fs.writeFileSync(
      cfgPath,
      "g:\n  commands:\n    - label: Ok\n      command: echo hello\n    - label: Extra\n      command: echo extra\n",
    );
    await write(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "list_commands", arguments: {} },
      },
      400,
    );
    child.stdin?.end();
    const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
    const guard = setTimeout(() => child.kill("SIGKILL"), 5000);
    await closed;
    clearTimeout(guard);
    const byId = Object.fromEntries(responses.map((r) => [r.id, r]));
    expect(byId[1].result.serverInfo.name).toBe("shell-runner");
    expect(byId[2].result.content[0].text).toContain("exit code: 0");
    expect(byId[4].result.content[0].text).toContain("g__ok");
    expect(byId[5].result.content[0].text).toContain("g__extra");
    expect(responses.some((r) => r.method === "notifications/tools/list_changed")).toBe(true);
    expect(Date.now() - started).toBeLessThan(15000);
  }, 20000);
});
