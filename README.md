# MCP Shell Runner

[![Latest Version on npm](https://img.shields.io/npm/v/@laragear/mcp-shell.svg)](https://www.npmjs.com/package/@laragear/mcp-shell)
[![Latest stable test run](https://github.com/Laragear/mcp-shell/actions/workflows/test.yml/badge.svg)](https://github.com/DarkGhostHunter/mcp-shell/actions/workflows/test.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE.md)

Let your AI agent run your project commands, and nothing else. Yes, only the ones you allow.

```yaml
frontend:
  description: Build, test and lint the Vue app
  trigger: Code changes, before committing, on request.
  commands:
    - label: Run unit tests
      command: npx vitest run
      args: true
```

## Become a sponsor

[![](.github/assets/support.png)](https://github.com/sponsors/DarkGhostHunter)

Your support allows me to keep this package free, up-to-date and maintainable. Alternatively, you can **spread the word on social media!**

## Requirements

* Node.js 22 or later
* Any MCP client, like Claude Code, Codex, Copilot, ZCode, Kimi Code, to name some

## Installation

Fire up your MCP client and register the server. There is no install step if you use `npx`:

```json
{
  "mcpServers": {
    "shell-runner": {
      "command": "npx",
      "args": ["-y", "@laragear/mcp-shell"]
    }
  }
}
```

Each client keeps this file in a different place: `.mcp.json` for Claude Code, `~/.codex/config.toml` for Codex, `.vscode/mcp.json` for Copilot in VS Code, to name some. The JSON itself is the same everywhere.

Alternatively, you may install the package into your project.

```bash
npm install @laragear/mcp-shell
```

## How does it work?

You write a config file listing the shell commands you are comfortable with. The server reads the file and turns each command into an MCP tool. The agent calls the tool and receives the exit code, stdout and stderr back.

What the agent does not receive is a shell. It can only run what is in your config, and a command without arguments runs exactly as written, every time. If your config says `npm test`, the only thing that can ever execute is `npm test`.

By default, the config file is re-read on every tool call, so your changes apply immediately.

## Usage

There are two ways to create the command list. You may have the agent propose the commands and approve each one in a dialog, or write the config file by hand. Both end in the same place: a config file you control.

### Letting the agent propose the commands

You may skip the manual editing and have the agent do the typing. Ask it something like *"add a command that runs the test suite"*, and it will call its `save_command` tool with a proposal. Your MCP client then shows you a dialog with the exact YAML: the group, the command label and the full command line. Nothing is written until you accept.

* **Accept**, and the command lands in `~/.agents/mcp-shell/<project>/agent.yaml`, a file only the server writes. The new tool is available immediately, no restarts.
* **Decline**, and nothing is written. The agent is told you said no.

The agent never edits your own config file. Proposals land in their own file, which merges beneath your config per group: your groups always win wholesale, agent groups only fill the gaps. If you later declare a group with the same name, the agent group is shadowed and the doctor report says so. The agent can also propose removing a command it previously added, with the same dialog, but it can never touch commands you declared yourself.

```yaml
frontend:
  description: Frontend commands
  commands:
    - label: Run tests
      command: npm test
```

> [!IMPORTANT]
>
> Approving a proposal is the same as writing the command yourself. Read the command line in the dialog before accepting, because the agent could propose anything. The agent file lives in your home directory, outside any repository, so review its content with `list_commands` from time to time.

> [!NOTE]
>
> The approval dialog uses MCP elicitation, which not every client supports. When yours does not, the proposal tools answer with an error telling the agent to ask you to add the command by hand. They never fall back to writing anything. Proposals are also refused while `$SHELL_RUNNER_CONFIG` is set, because an explicit config is used alone.

You may read the doctor report at any time: groups the agent proposed are marked with `(agent-proposed)`.

### Writing the config by hand

Create a `shell-runner.yaml` in your project. Here is one for a Vue 3, Vite and TypeScript app:

```yaml
frontend:
  description: Build, test and lint the Vue app
  trigger: Code changes, before committing, on request.
  env:
    CI: true
  commands:
    - label: Run unit tests
      command: npx vitest run
      args: true                  # the agent may append file paths to test
      check:
        not_contains: [FAIL]

    - label: Type-check and build
      command: vue-tsc --noEmit && vite build

    - label: Lint a file
      command: npx eslint --fix
      args:
        - name: file
          description: File to lint (relative to the project root)
          required: true
```

With this config the agent gets three tools: `frontend__run_unit_tests`, `frontend__type_check_and_build` and `frontend__lint_a_file`. Nothing else is runnable.

> [!TIP]
>
> Not sure what the server sees? Ask the agent to call `list_commands`. It answers with a doctor report: the config file in use, every problem found and the exact command line each tool will run.

You do not have to remember every key. Call the `config_template` tool (or run the CLI with `--template`) and you get a fill-in YAML file of the current configuration with every supported option visible as a commented reference. Starting from nothing, it emits a starter template you **can save straight into the trusted store with `--template --save agents`**.

### Type hints for hand-written configs

The package ships a JSON Schema of the config file, `commands.schema.json`, next to the compiled server. Every generated template starts with a line that binds your editor to it, and the server picks the most portable reference it can find, in this order:

1. `./node_modules/@laragear/mcp-shell/commands.schema.json`, when the package is installed in the project
2. `.agents/commands.schema.json`, when you dumped the schema there yourself
3. `https://cdn.jsdelivr.net/npm/@laragear/mcp-shell@latest/commands.schema.json`, the pinned CDN copy, for pure `npx` setups

```yaml
# yaml-language-server: $schema=https://cdn.jsdelivr.net/npm/@laragear/mcp-shell@latest/commands.schema.json
```

Keep that line as the first line of your `shell-runner.yaml` and any editor with YAML language support (VS Code, JetBrains, Zed, Neovim with yaml-language-server) gives you completion, key descriptions and validation as you type. It is committable, so everyone on the project gets the same hints.

If you prefer a local file over the CDN, dump the schema next to your config and commit both:

```bash
npx @laragear/mcp-shell --schema --save agents
```

The emitted `$schema` line then becomes `.agents/commands.schema.json` on the next `config_template` call.

Agents get the same schema through the `config_schema` tool, which returns it verbatim. Tell the agent to *fetch the schema with `config_schema`, then write a `shell-runner.yaml`* and it never invents a key. For single-command proposals the `save_command` tool carries the same knowledge in its own input schema.

### Arguments

By default, `args` is `false`, which means the command runs **exactly as written** and accepts no arguments. The agent can press the button, but not move the furniture.

You may open it in two ways. Use `args: true` to let the agent append free-form arguments, which are shell-quoted before joining the command line. Use a list of named arguments to control what the agent can pass, each with its own `description` and optional `default`.

Named arguments fill `{placeholders}` in the command line when you declare them, which allows arguments in the middle of the command. Arguments without a placeholder are appended in declared order, as before.

```yaml
- label: Pods in namespace
  command: kubectl --namespace {ns} get pods
  args:
    - name: ns
      required: true
```

An optional argument that needs its own flag does not have to live in the command line. Declare a literal `prefix` or `suffix` and the decoration is glued around the shell-quoted value only when the agent passes the argument. Omitted optionals leave nothing behind.

```yaml
- label: Docker run
  command: docker run img
  args:
    - name: memory
      description: Container memory limit
      prefix: "--memory "        # note the trailing space
    - name: mode
      description: Volume mode
      suffix: ":rw"              # mounts read-write
```

With both arguments present this runs `docker run img --memory '512m' 'data':rw`. An argument may carry a `prefix`, a `suffix` or both, and they combine with `{placeholders}` like any other argument.

> [!NOTE]
>
> Arguments are shell-quoted, so these cannot break out of the quoting. The `prefix` and `suffix` are yours, written in the config, so they are as trusted as the command itself. Still, the command decides what everything means. Prefer named arguments for anything that deletes, deploys or writes.

### Checking the output

You may add a `check` to a command to verify its output after every run. All present rules must pass.

```yaml
check:
  not_contains: [FAIL]
  regex: ['\d+ passed']
```

When a rule fails, the result is prefixed with `CHECK FAILED:` and marked as an error, so the agent notices without parsing the output itself.

### Piping the output

The `pipe` key pipes the command stdout through a second command, and the tool result becomes *its* output. Great to turn a wall of test text into the last 20 lines. The exit code is always the **first** command's, so a failing test suite never passes because `tail` succeeded.

```yaml
- label: Tests with summary
  command: npx vitest run 2>&1
  pipe: tail -20
```

### Writing output to a file

By default, output lives only in the tool result, truncated at `max_output`. You may opt a command into writing its raw output to a file, which is disabled by default because output can carry secrets, and a file outlives the conversation.

The config decides everything: whether file output exists at all, where files land, and whether the agent may opt in per call.

```yaml
- label: Run build
  command: npm run build
  output_to: logs/{command}.log        # written on every run
```

Pass a mapping for more control. A `dir` with `allow_agent: true` hands the decision to the agent: the tool gains an `output_to` argument it may set to `true` (an auto-named `<command>-<timestamp>.json|.txt` file) or to a strict filename like `report.txt` (letters, digits, one optional dot, extension `txt`, `log` or `json`).

```yaml
- label: Run build
  command: npm run build
  output_to:
    dir: logs/          # the agent never chooses the directory
    allow_agent: true
    append: false       # truncate per run
    stderr: false       # capture stdout only
```

Like `timeout` and `max_output`, the nearest definition wins: `defaults`, then group, then command, and `output_to: false` on a command disables an enabled group. Files are created with owner-only permissions, `{command}` and `{group}` placeholders expand in paths and directories, and a run that produced no output creates no file. The file receives the **raw** stdout of the command, so a `pipe` stage shapes only the result the agent reads. When a file is written, the result says where it landed with an `output file:` line.

> [!WARNING]
>
> Three channels leak secrets. The command line is visible in the process list while running, so pass secrets through `env` instead of arguments. Whatever the command prints reaches the conversation and the model provider. And a file written with `output_to` persists everything the command printed on disk. Keep `allow_agent` off for commands that handle credentials.

## Configuration

Where does the config file go? The server checks these locations in order and the first existing file wins.

1. `$SHELL_RUNNER_CONFIG`, an explicit path, handy for CI. When set, it is used alone
2. `~/.agents/mcp-shell/<project>/commands.yaml`, the trusted store for this project, outside the project tree
3. `~/.agents/shell-runner.yaml`, a user-global fallback

The trusted store and the user-global config are not exclusive: the server merges them **per group**. Store groups override same-named global groups, the global file supplies the rest, and `defaults` merge with store precedence. Commands you share through the user-global file become available everywhere, instead of only where no store config exists.

The store path encodes your project directory, so every project gets its own file. Run the CLI with `--template --save agents` to create it, and the server re-reads it on every tool call, so there are no restarts to worry about.

The agent file `~/.agents/mcp-shell/<project>/agent.yaml` joins the merge one slot below both: your groups win wholesale and agent groups fill the gaps. See [Letting the agent propose the commands](#letting-the-agent-propose-the-commands).

> [!WARNING]
>
> Nothing inside the project tree is ever loaded as configuration. Whoever can write into the project can also point a command at your files, and a full-access agent can do exactly that without asking. A `<project>/.agents/shell-runner.yaml` file is treated as a **proposal**: the server never loads it, `list_commands` tells you it exists, and running the CLI with `--merge` shows you its full content and folds it into the trusted store after you confirm with a `y`.

> [!IMPORTANT]
>
> A config file that fails to parse is decisive. The server reports the error and exposes no commands, instead of silently falling back to the next location.

### YAML notes

The bundled parser supports nested mappings, block sequences, flow sequences `[a, b]`, flow mappings `{ A: 1 }`, block scalars with `|` and `>`, comments and quoted scalars. Multi-line plain scalars, anchors and aliases are not supported, so use block scalars or JSON for anything fancy.

```yaml
command: |
  vue-tsc --noEmit
  vite build
```

### Cancelling a running command

You may cancel a running tool call, and so may the agent or the client. The server kills the whole process group, first with `SIGTERM` and then with `SIGKILL` after a short grace, so pipelines and child processes die with it. The cancelled call answers immediately with a cancellation error, and never waits for its timeout. When the session itself closes, any command still running is killed the same way.

### Command keys

| Key                                   | Meaning.                                                                                                |
|---------------------------------------|---------------------------------------------------------------------------------------------------------|
| `label` (required)                    | Short human-readable label, slugged into the tool name.                                                 |
| `command` (required)                  | The command line, run through the shell. Pipes and redirects work.                                      |
| `args`                                | `false` by default. `true` allows free-form arguments. A list declares named arguments.                 |
| `description`                         | Refines the tool description shown to the agent.                                                        |
| `env`, `timeout`, `cwd`, `max_output` | Per-command overrides.                                                                                  |
| `pipe`                                | Second command piped after stdout, the tool result is its output and the exit code stays the command's. |
| `check`                               | Success rules on the output: `contains`, `not_contains`, `regex` and `not_regex`.                       |
| `output_to`                           | Opt-in raw output to a file. Disabled by default, because output can carry secrets.                     |
| `read_only`, `destructive`            | Hints for the client, surfaced as MCP annotations.                                                      |

Group keys work the same way, one level up: `description`, `trigger`, `env`, `timeout`, `cwd` and `commands`, which is required.

### Timeouts and output size

Every command has a timeout and an output limit, resolved as `command > group > defaults > environment > built-in`. By default is `timeout: 120` seconds and `max_output: 20000` characters, which is mostly enough for a test suite.

```yaml
defaults:
  timeout: 120
  max_output: 20000
```

Raise the timeout for slow commands, like a full build with coverage. Lower `max_output` for commands that spew thousands of lines, since the result gets truncated and the agent only needs the tail anyway.

### Tool naming

Tools are named `<group>__<slug>`. Both parts are lowercased and anything non-alphanumeric becomes an underscore, so `frontend` with `Lint a file` becomes `frontend__lint_a_file`. Name collisions get a deterministic `_2` suffix and are reported by `list_commands`.

### The built-in tools

The server always exposes five tools of its own.

| Tool              | Purpose.                                                                                  |
|-------------------|-------------------------------------------------------------------------------------------|
| `list_commands`   | The doctor report: config file in use, every issue, exact command lines.                  |
| `config_template` | A fill-in YAML template of the current config, every supported key visible and commented. |
| `config_schema`   | The JSON Schema of the config file, for editor type hints and agents writing configs.     |
| `save_command`    | Lets the agent propose a command. Nothing is written until you approve it in a dialog.    |
| `remove_command`  | Lets the agent propose removing one of its own commands, with the same dialog.            |

For CI, you may skip the MCP session entirely and go full manual.

```bash
# Doctor report for a config; exit 0 = valid, 1 = issues found
node node_modules/@laragear/mcp-shell/mcp/main.js --validate [path]

# Print a fill-in YAML template of the current config
node node_modules/@laragear/mcp-shell/mcp/main.js --template [path]

# Save the template as the trusted store of the project, or the user-global one
node node_modules/@laragear/mcp-shell/mcp/main.js --template --save agents
node node_modules/@laragear/mcp-shell/mcp/main.js --template --save user --force

# Review a <project>/.agents/shell-runner.yaml proposal into the trusted store
node node_modules/@laragear/mcp-shell/mcp/main.js --merge

# Print the config JSON Schema, or save it next to the project config
node node_modules/@laragear/mcp-shell/mcp/main.js --schema
node node_modules/@laragear/mcp-shell/mcp/main.js --schema --save agents --force
```

Saving refuses to replace an existing file unless you pass `--force`. You may also run the test suite with `npm test`.

## Security

Commands run through the shell, with the agent environment plus whatever `env` you configure. Whoever can edit the config file can run arbitrary code, so treat it as code, review it and keep it in version control. Quoting follows POSIX shells, so use Linux, macOS or WSL, and ensure the config never lands in untrusted hands. Remember the secret leak channels covered in [Writing output to a file](#writing-output-to-a-file).

The proposal tools do not change this. Each approval dialog shows the exact command line, and accepting one is the same as typing it into the config yourself, so read before you accept. The agent has no standing write access: it cannot touch your config files, it cannot add commands to your groups, and every change it proposes needs a fresh approval. If a proposal looks wrong, decline it and nothing happens.

If you discover any security-related issue, please [use the online form](https://github.com/Laragear/MCP-Shell-Runner/security).

# License

This specific package version is licensed under the terms of the [MIT License](LICENSE.md), at the time of publishing.
