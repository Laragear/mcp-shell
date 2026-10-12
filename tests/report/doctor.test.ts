import { describe, expect, it } from "vitest";
import { doctorReport } from "../../src/report/index.js";
import type { LoadedConfig } from "../../src/config/index.js";

/** A LoadedConfig built by hand, so every report branch is reachable. */
function cfg(overrides: Partial<LoadedConfig>): LoadedConfig {
  return {
    path: null,
    paths: [],
    groups: {},
    defaults: {},
    issues: [],
    ...overrides,
  };
}

describe("doctor report", () => {
  it("reports a missing config", () => {
    const report = doctorReport(cfg({}));
    expect(report).toContain("none found — no commands exposed");
    expect(report).toContain("Config issues: none");
    expect(report).toContain("Built-in tools: list_commands, config_template, config_schema");
  });

  it("reports the merge note when project and user configs are merged", () => {
    const report = doctorReport(cfg({ paths: ["/p/.agents/cfg.yaml", "/h/.agents/cfg.yaml"] }));
    expect(report).toContain("Config: /p/.agents/cfg.yaml + /h/.agents/cfg.yaml");
    expect(report).toContain("Merge: trusted store groups override");
  });

  it("lists the agent file and the project proposal when present", () => {
    const report = doctorReport(
      cfg({
        agentPath: "/home/.agents/mcp-shell/proj/agent.yaml",
        proposalPath: "/proj/.agents/shell-runner.yaml",
      }),
    );
    expect(report).toContain("Agent file: /home/.agents/mcp-shell/proj/agent.yaml");
    expect(report).toContain("Proposal: /proj/.agents/shell-runner.yaml");
    expect(report).toContain("`--merge`");
  });

  it("lists every issue with its index", () => {
    const report = doctorReport(
      cfg({ issues: ['group "g": must be a mapping', "config declares no commands"] }),
    );
    expect(report).toContain("Config issues (2)");
    expect(report).toContain('  ! group "g": must be a mapping');
  });

  it("shows group settings, extras and effective timeout deviations", () => {
    const report = doctorReport(
      cfg({
        paths: ["cfg.yaml"],
        defaults: { timeout: 30 },
        groups: {
          g: {
            description: "The g group",
            trigger: "When testing",
            timeout: 5,
            cwd: "./sub",
            output_to: "logs/out.log",
            commands: [
              {
                label: "Build",
                command: "make {target}",
                args: [{ name: "target", required: true }],
                pipe: "tail -5",
                check: { contains: ["done"], not_contains: ["error"] },
                timeout: 9,
                output_to: { dir: "logs/", allow_agent: true },
              },
            ],
          },
        },
      }),
    );
    expect(report).toContain("## g");
    expect(report).toContain("The g group");
    expect(report).toContain("Trigger when: When testing");
    expect(report).toContain("Group settings: timeout=5s, cwd=./sub");
    expect(report).toContain('output_to="logs/out.log"');
    expect(report).toContain("accepts arguments");
    expect(report).toContain("pipe: tail -5");
    expect(report).toContain("output to: logs/ (agent-decided)");
    expect(report).toContain('check: contains=["done"], not_contains=["error"]');
    expect(report).toContain("timeout=9s");
    expect(report).toContain("g__build");
  });

  it("shows non-agent file output and array-form check rules", () => {
    const report = doctorReport(
      cfg({
        groups: {
          g: {
            commands: [
              {
                label: "A",
                command: "echo",
                check: { regex: ["\\d+", "x"] },
                output_to: "out.txt",
              },
            ],
          },
        },
      }),
    );
    expect(report).toContain("output to: out.txt");
    expect(report).toContain('regex=["\\\\d+","x"]');
    expect(report).not.toContain("accepts arguments");
  });
});

describe("doctor report corners", () => {
  it("renders group output_to alone and skips a blank parse stage", () => {
    const report = doctorReport(
      cfg({
        paths: ["cfg.yaml"],
        groups: {
          g: {
            output_to: "logs/",
            commands: [{ label: "A", command: "echo", pipe: "   " }],
          },
        },
      }),
    );
    expect(report).toContain('Group settings: output_to="logs/"');
    expect(report).not.toContain("parse:");
  });

  it("renders group timeout and cwd without output_to, and scalar check values", () => {
    const report = doctorReport(
      cfg({
        paths: ["cfg.yaml"],
        groups: {
          g: {
            timeout: 5,
            cwd: "./x",
            commands: [{ label: "A", command: "echo", check: { contains: "ok" } }],
          },
        },
      }),
    );
    expect(report).toContain("Group settings: timeout=5s, cwd=./x");
    expect(report).not.toContain("output_to=");
    expect(report).toContain('check: contains=["ok"]');
  });

  it("tolerates a null group map", () => {
    expect(doctorReport(cfg({ groups: null as any }))).toContain("Built-in tools:");
  });
});

describe("doctor extras", () => {
  it("renders a group with no description or trigger", () => {
    const report = doctorReport({
      path: null,
      paths: ["x"],
      groups: { g: { commands: [{ label: "A", command: "echo" }] } },
      defaults: {},
      issues: [],
    });
    expect(report).toContain("## g");
    expect(report).not.toContain("Group settings:");
  });
});

describe("doctor report secrets", () => {
  it("never shows declared env values in the doctor report", () => {
    const report = doctorReport(
      cfg({
        groups: {
          g: {
            env: { SECRET: "plain" },
            commands: [{ label: "A", command: "echo" }],
          },
        },
      }),
    );
    expect(report).not.toContain("plain");
  });
});

it("shows the effective truncate shape in the doctor report", () => {
  const report = doctorReport(
    cfg({
      groups: {
        g: {
          commands: [{ label: "A", command: "echo", output: { truncate: { bytes: 99 } } }],
        },
      },
    }),
  );
  expect(report).toContain("truncate: last 99 bytes");
});
