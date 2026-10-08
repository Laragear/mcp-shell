// YAML subset parser, no external dependencies. Full JSON also works and is
// handled by the config loader. Supports nested mappings, block sequences,
// flow sequences [a, b], flow mappings {a: b}, block scalars (|, >, with -
// and + chomping), quoted/plain scalars, booleans, numbers and comments.
// Rejects with a clear error and line number: tabs in indentation,
// anchors/aliases, multi-line plain scalars and inline block scalars.

import { YamlError, skipBlanks, tokenize } from "./scanner.js";
import { parseBlock } from "./structure.js";

export { YamlError };

/** Parses a YAML document into plain values, or throws YamlError with a
 * line number for everything the subset does not support. */
export function parseYaml(text: string): any {
  const rawLines = text.split("\n");
  const lines = tokenize(text);
  const i = skipBlanks(lines, 0);
  if (i >= lines.length) return null;
  const [value, next] = parseBlock(lines, i, lines[i].indent, rawLines);
  const end = skipBlanks(lines, next);
  if (end < lines.length)
    throw new YamlError(`line ${lines[end].line}: unexpected content "${lines[end].text}"`);
  return value;
}
