// Pure string helpers shared across the server.

const PLACEHOLDER_RE = /\{([A-Za-z0-9_-]+)\}/g;

const ENV_VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Lowercase a group or command name into a tool-name-safe slug.
 */
export function slug(value: unknown): string {
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "label"
  );
}

/**
 * POSIX single-quote a value so it can never break out of its quoting.
 */
export function shellQuote(value: unknown): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Every {name} placeholder used in a command line.
 */
export function commandPlaceholders(command: unknown): string[] {
  return [...String(command).matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
}

/**
 * Expand ${VAR} references in a configured env value against a lookup of the
 * parent environment. An unset variable expands to nothing, like a shell
 * would. Plain $VAR without braces is left alone.
 */
export function expandEnvVars(value: string, lookup: (name: string) => string | undefined): string {
  return value.replace(ENV_VAR_RE, (_, name: string) => lookup(name) ?? "");
}

/** Compiles a check-rule pattern as a multiline regex, or reports why the
 * pattern is invalid. Shared by config validation and output matching so both
 * accept exactly the same patterns. */
export function compileMultilineRegex(pattern: string): RegExp | { error: string } {
  try {
    return new RegExp(pattern, "m");
  } catch (e: any) {
    return { error: e.message };
  }
}

/**
 * Expand {command} and {group} in a configured path or directory.
 */
export function expandPlaceholders(
  template: string,
  groupName: string,
  commandName: string,
): string {
  return template.split("{command}").join(slug(commandName)).split("{group}").join(slug(groupName));
}

/**
 * Quotes a scalar for safe YAML output when it is not a plain scalar.
 */
export function yamlScalar(v: unknown): string {
  const s = String(v);
  if (
    s === "" ||
    /[:#{}[\]&*!|>'"%@`,\n]/.test(s) ||
    /^\s|\s$/.test(s) ||
    /^(true|false|null|~|-?[\d.]+)$/.test(s)
  ) {
    return `'${s.replace(/'/g, "''")}'`;
  }
  return s;
}

/**
 * Compact local timestamp for auto-named output files: 20261008T142530.
 */
export function timestampSlug(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = date;
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
