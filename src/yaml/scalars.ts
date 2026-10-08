// Scalars: leaf values. Plain/quoted/boolean/number scalars, flow
// collections [a, b] and {a: b}, and block scalars (|, >, with - and +
// chomping).

import { YamlError, type Token } from "./scanner.js";

/** Splits "a, b, "c, d"" on top-level commas, honoring quotes and nested
 * flow collections. Returns raw parts; callers parse each one. */
function splitTopLevel(inner: string): string[] {
  const items: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let depth = 0;
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "[" || ch === "{") {
      depth++;
      cur += ch;
    } else if (ch === "]" || ch === "}") {
      depth--;
      cur += ch;
    } else if (ch === "," && depth === 0) {
      items.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  items.push(cur.trim());
  return items;
}

/**
 * Parses the inside of a flow sequence into values.
 */
function parseFlowSequence(inner: string, lineNo: number): any[] {
  if (inner.trim() === "") return [];
  return splitTopLevel(inner).map((part) => parseScalar(part, lineNo));
}

/**
 * Parses the inside of a flow mapping into a plain object.
 */
function parseFlowMapping(inner: string, lineNo: number): Record<string, any> {
  const map: Record<string, any> = {};
  if (inner.trim() === "") return map;
  for (const part of splitTopLevel(inner)) {
    const m = part.match(/^([^:]+):(.*)$/);
    if (!m)
      throw new YamlError(
        `line ${lineNo}: cannot parse flow mapping entry "${part}" (expected "key: value")`,
      );
    const key = parseScalar(m[1], lineNo);
    if (typeof key !== "string")
      throw new YamlError(`line ${lineNo}: flow mapping key must be a string`);
    map[key] = parseScalar(m[2], lineNo);
  }
  return map;
}

/** Parses one inline scalar: null/boolean/number, quoted strings, or flow
 * collections; everything else stays a plain string. */
export function parseScalar(s: string, lineNo: number): any {
  s = s.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s.startsWith("&") || s.startsWith("*")) {
    throw new YamlError(`line ${lineNo}: anchors/aliases (&x, *x) are not supported`);
  }
  if (s[0] === "|" || s[0] === ">") {
    throw new YamlError(
      `line ${lineNo}: block scalars must be opened by a mapping key, not used inline`,
    );
  }
  if ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'")) {
    const inner = s.slice(1, -1);
    return s[0] === "'" ? inner.replace(/''/g, "'") : inner;
  }
  if (s === "true") return true;
  if (s === "false") return false;
  const n = Number(s);
  if (!Number.isNaN(n) && /^-?[\d.]+$/.test(s)) return n;
  if (s[0] === "[" && s[s.length - 1] === "]") return parseFlowSequence(s.slice(1, -1), lineNo);
  if (s[0] === "{" && s[s.length - 1] === "}") return parseFlowMapping(s.slice(1, -1), lineNo);
  return s;
}

/** Collects every raw line deeper than the parent key's indent, blank lines
 * included; the content indent comes from the first non-blank line. */
function collectBlockLines(
  lines: Token[],
  i: number,
  parentIndent: number,
  rawLines: string[],
): Array<{ blank: boolean; indent: number; text: string }> {
  const collected: Array<{ blank: boolean; indent: number; text: string }> = [];
  while (i < lines.length) {
    const tok = lines[i];
    if (tok.blank) {
      collected.push({ blank: true, indent: Infinity, text: "" });
      i++;
      continue;
    }
    if (tok.indent <= parentIndent) break;
    collected.push({ blank: false, indent: tok.indent, text: rawLines[tok.line - 1] });
    i++;
  }
  return collected;
}

/** Joins the collected block lines under literal or folded style, tracking
 * blank runs and lines that are more-indented than the block indent. */
function joinBlockLines(
  collected: Array<{ blank: boolean; indent: number; text: string }>,
  blockIndent: number,
  folded: boolean,
): string {
  const body = collected.map((l) => ({
    blank: l.blank,
    more: !l.blank && l.indent > blockIndent,
    text: l.blank ? "" : l.text.slice(blockIndent).replace(/\s+$/, ""),
  }));
  while (body.length && body[body.length - 1].blank) body.pop();
  let text = "";
  let blanks = 0;
  let prevMore = false;
  for (const line of body) {
    if (line.blank) {
      blanks++;
      continue;
    }
    if (text === "") {
      text = line.text;
    } else if (blanks > 0) {
      // Literal keeps one newline per blank line plus the line break; folded
      // collapses each blank line into a single newline.
      text += "\n".repeat(folded ? blanks : blanks + 1) + line.text;
    } else if (folded && !line.more && !prevMore) {
      text += ` ${line.text}`;
    } else {
      text += `\n${line.text}`;
    }
    blanks = 0;
    prevMore = line.more;
  }
  return text;
}

/** Applies the chomping indicator: keep preserves trailing blank lines,
 * clip ends with one newline, strip removes them all. */
function applyChomping(
  text: string,
  chomp: "keep" | "clip" | "strip",
  collected: Array<{ blank: boolean }>,
): string {
  if (text === "" || chomp === "strip") return text;
  if (chomp === "clip") return `${text}\n`;
  let keep = 0;
  for (let j = collected.length - 1; j >= 0; j--) {
    if (collected[j].blank) keep++;
    else break;
  }
  return text + "\n".repeat(1 + keep);
}

/** Reads a block scalar body starting after its "|"/">" header line. Returns
 * the scalar text and the index of the first line after the block. */
export function readBlockScalar(
  lines: Token[],
  i: number,
  parentIndent: number,
  style: string,
  rawLines: string[],
): [string, number] {
  const chomp = style.includes("-") ? "strip" : style.includes("+") ? "keep" : "clip";
  const folded = style[0] === ">";
  const collected = collectBlockLines(lines, i, parentIndent, rawLines);
  const content = collected.filter((l) => !l.blank);
  const blockIndent = content.length ? content[0].indent : parentIndent + 2;
  const text = joinBlockLines(collected, blockIndent, folded);
  return [applyChomping(text, chomp, collected), i + collected.length];
}
