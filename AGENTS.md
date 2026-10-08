# AGENTS.md

Instructions for AI agents working in this repository. This file assumes you know how to code but nothing about MCP; read the primer first.

## What this project is

`@laragear/mcp-shell-runner` is an MCP server that exposes **only the shell commands a human declares** in a YAML or JSON config file, so an AI agent can run project commands like tests, builds and linters without free-form shell access. Every declared command becomes one MCP tool named `<group>__<slug>`; if the config says `npm test`, that is the only thing that can ever execute.

## How this server works, end to end

1. A human writes a config file (YAML or JSON) declaring groups of commands. See [Configuration sources](#configuration-sources) for where it is looked up.
2. On every tool call the config is re-read from disk, so edits apply with no restarts.
3. Each valid command becomes one MCP tool. A command declares `label` (a short human phrase, slugged into the tool name) and `command` (the shell line), plus optional keys (`description`, `args`, `env`, `timeout`, `cwd`, `pipe`, `check`, `max_output`, `read_only`, `destructive`, `output_to`) documented in `commands.schema.json`. Named arguments may carry a literal `prefix`/`suffix` glued around the shell-quoted value; the value stays quoted, only the human-authored decoration sits outside it. The tool name is `<group>__<slug>`: both parts are lowercased, non-alphanumerics become underscores, capped at 40 chars, and collisions get a deterministic `_2` suffix. Invalid commands are excluded from the tool list and reported as config issues.
4. Calling a command tool spawns a shell process (the whole process group, killed with SIGTERM then SIGKILL on timeout or cancel), captures bounded stdout/stderr, applies check rules and the optional `pipe` stage, and answers with text plus the output contract below.
5. The server also exposes five always-present built-in tools: `list_commands` (a doctor report of the effective config), `config_template` (a fill-in, fully commented YAML template of the config), `config_schema` (the bundled JSON Schema of the config file, `commands.schema.json`, for editor type hints and schema-first agents), and the elicitation-gated `save_command` and `remove_command` with which the agent can propose commands.

**Output contract** (central, do not weaken): `isError` is true exactly when the command timed out, exited non-zero, or failed its `check`; a `pipe` stage never changes the exit code. Timeout kills report "Timed out", external signals report "killed by signal".

## Configuration sources

Looked up in order, first match wins:

1. `$SHELL_RUNNER_CONFIG`, an explicit path, used alone (agent proposals are refused in this mode)
2. `~/.agents/mcp-shell-runner/<project-slug>/commands.yaml`, the trusted per-project store (the authoritative config, outside the project tree)
3. `~/.agents/shell-runner.{yaml,yml,json}`, user-global, merged per group beneath the store (store groups win wholesale)
4. `~/.agents/mcp-shell-runner/<project-slug>/agent.yaml`, the agent file: commands the human approved through `save_command`, merged beneath everything else (agent groups only fill gaps a human config does not declare; a shadowed agent group produces a config issue)

Nothing inside the project tree is loaded as config. A `<project>/.agents/shell-runner.{yaml,yml,json}` file is a proposal: never executed, reported by the doctor, and folded into the store only by the human-run `--merge` CLI (whole-file y/N confirm; conflicting store groups are overwritten, store defaults survive).

Whoever edits a config file can run arbitrary code, so config is treated as untrusted input: everything parsed from disk is validated in `config/validate.ts` before it is exposed.

## Architecture

TypeScript in `src/`, compiled by `tsc` to `mcp/` (build output, gitignored). The project is ESM (`"type": "module"`); relative imports carry `.js` extensions. The published `bin` is the compiled `mcp/main.js`. **Do not edit `mcp/`.**

One module per subdomain:

| Module | Owns|
|---|---|
| `src/support.ts` | Pure string helpers: slugs, shell quoting, `{placeholders}`, YAML scalar quoting, regex compilation, timestamps |
| `src/yaml/`| The YAML subset parser (no dependencies, throws `YamlError` with line numbers): `scanner.ts` tokens, `scalars.ts` values and block scalars, `structure.ts` blocks |
| `src/config/`| Types (`types.ts`), discovery (`discover.ts`: trusted store path, project slug, agent file path, project proposals), parsing and merging (`load.ts`), validation (`validate.ts`), the `output_to` sub-domain (`output.ts`), limit precedence (`limits.ts`), the agent-approved commands file (`agent.ts`: strict YAML emitter, validated upsert/remove, atomic owner-only writes, mutex) |
| `src/tools/` | Tool generation from config (`registry.ts`, which also holds the five built-in definitions), per-tool schemas and descriptions (`schema.ts`), command-line building with shell quoting, named-argument `prefix`/`suffix` decoration and previews (`commandline.ts`) |
| `src/runner/`| Execution: bounded capture (`capture.ts`), process groups and teardown (`kill.ts`, `process.ts`), check rules (`check.ts`), `output_to` file tee (`output-file.ts`), result shaping (`format.ts`), run preparation (`prepare.ts`), the output contract (`run.ts`) |
| `src/report/`| Human-facing text: the `list_commands` doctor report (`doctor.ts`) and the config template (`template.ts`, which also resolves the `$schema` reference: local install, `.agents` dump, then the pinned CDN copy; block emission in `yaml.ts` and `group.ts`) |
| `src/server/`| The FastMCP wiring (`index.ts`, including the elicitation-gated proposal handlers), zod input schemas (`schemas.ts`), cancellation signal plumbing (`middleware.ts`) |
| `src/main.ts`| The binary entry point: CLI dispatch, otherwise stdio |
| `src/cli.ts` | The `validate` / `merge` / `template` / `schema` CLI, including `save` targets and the schema dump next to the project config |
| `src/stdio.ts` | Process teardown on client disconnect and signals; the transport itself is fastmcp's |

Every directory re-exports its public surface from `index.ts`; consumers import the directory (`./config/index.js`), never a file inside it.

The protocol layer is [`@prefecthq/fastmcp-ts`](https://github.com/PrefectHQ/fastmcp-ts) (the official FastMCP TypeScript framework) with `zod`. FastMCP owns the JSON-RPC plumbing: initialize, serving the tool list, converting results and emitting `notifications/tools/list_changed`. Config files are re-read on every tool call and the tool set is re-registered when a signature of the config changes; fastmcp emits the notification itself. FastMCP hands handlers no AbortSignal, so `server/middleware.ts` pairs the built-in `CancellationMiddleware` with a thin outer middleware that exposes the abort to the run handlers; keep that pairing intact.

Agent proposals use the framework's multi-round-trip flow: the handler returns `inputRequired({ inputRequests: { approve: inputRequired.elicit(...) } })`, the client collects the human's answer, and the handler is re-entered with it available on `server.getContext().inputResponses`. On older (2025-era) connections the framework's legacy shim fulfils the same return as a real server-to-client request, so one code path serves both eras.

Read `package.json` for the authoritative dependency list and scripts: runtime dependencies are only `@prefecthq/fastmcp-ts` and `zod`; everything else (`typescript`, `vitest`, `@biomejs/biome`, `@types/node`) is dev-only. `npm test` builds and runs Vitest; `npm run lint` runs Biome; `npm run check` type-checks `src` and `tests` with `tsc --noEmit`.

## Styling

- Biome formats and lints (`npm run lint`, `npm run format`). Double quotes, semicolons, 2-space indent, 100-column lines. Keep `npm run lint` clean.
- Strict TypeScript. `any` is allowed only at the untrusted-config boundary (YAML/JSON parsing), where runtime validation in `config/validate.ts` is the real guard.
- Tests live in `tests/`, one file per module, using Vitest. Prefer in-process tests (fastmcp `Client.connect(server)`, with `{ handlers: { elicitation } }` to answer proposal dialogs); spawn the compiled `mcp/main.js` only for wire-level behavior. `vitest.config.ts` enforces 100% line, function, statement and branch coverage, so every defensive branch must be reachable and tested, or deleted.
- Documentation (README, templates) follows author voice: short paragraphs, no em-dashes, no semicolons, no Oxford commas, no emojis in prose, "You may..." for options, GitHub admonitions (`[!NOTE]`, `[!WARNING]`). Never remove or "fix" the maintainer's intentional phrasing.

## Constraints

- **Snake_case for all config keys** (`max_output`, `read_only`). MCP protocol fields (`readOnlyHint`) stay camelCase.
- **Arguments are shell-quoted, never interpolated raw.** A command with `args: false` runs exactly as written; never weaken this default.
- **The output contract is central**: `isError` is true exactly when the command timed out, exited non-zero, or failed its `check`; a `pipe` stage never changes the exit code. Timeout kills report "Timed out", external signals report "killed by signal".
- **Security stance**: whoever edits the config runs arbitrary code, so treat config as code. Output-to-file (`output_to`) stays opt-in and files are owner-only. Secrets given to tools must never surface in server-generated text.
- **Agent writes pass elicitation, always**: `save_command` and `remove_command` write only the agent file next to the trusted store (`~/.agents/mcp-shell-runner/<project>/agent.yaml`), only after the human accepts the approval dialog, and the write is re-validated. Human config files are never rewritten and agent groups never override human groups. Never add a path where the agent writes config without that dialog.
- Node.js >= 18, POSIX shells only. Keep the runtime dependency list minimal.

## Recommendations

- Run `npm run lint && npm run check && npm test` before finishing.
- Reuse what exists in `src/support.ts` before writing a new helper.
- Prefer boring, small modules; one subdomain per file.
- When touching the YAML parser or the runner, add a test next to the module you changed.

## Avoidances

- Do not edit `mcp/` (compiled output) or commit it.
- Do not add runtime dependencies without a compelling reason; the stdlib and `src/` helpers cover most needs.
- Do not reintroduce project-tree config loading (`<project>/.agents/shell-runner.*` stays a proposal merged with `--merge`), and do not reintroduce per-harness config directories (`.claude/`, `.codex/`, ...).
- Do not hand-send `notifications/tools/list_changed` — fastmcp emits it on `tool()`/`_removeTool()`.
- Do not add speculative features, config keys, or abstractions with a single caller (YAGNI). Deletion over addition.
- Do not remove or restyle the sponsor section, badge row, or license wording in the README.
