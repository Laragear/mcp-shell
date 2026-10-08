// Structure: block mappings and sequences, mutually recursive via parseBlock.

import { YamlError, skipBlanks, type Token } from "./scanner.js";
import { parseScalar, readBlockScalar } from "./scalars.js";

/**
 * Dispatches to the sequence or mapping parser at the current indent.
 */
export function parseBlock(
  lines: Token[],
  i: number,
  _indent: number,
  rawLines: string[],
): [any, number] {
  i = skipBlanks(lines, i);
  // Callers guarantee i is a live line indented deeper than the parent.
  if (lines[i].text.startsWith("- ") || lines[i].text === "-") {
    return parseSequence(lines, i, lines[i].indent, rawLines);
  }
  return parseMapping(lines, i, lines[i].indent, rawLines);
}

/** Parses consecutive "key: value" lines at one indent; a key with no inline
 * value opens a nested block, a "|"/">" value opens a block scalar. */
export function parseMapping(
  lines: Token[],
  i: number,
  indent: number,
  rawLines: string[],
): [Record<string, any>, number] {
  const map: Record<string, any> = {};
  while (i < lines.length) {
    if (lines[i].blank) {
      i++;
      continue;
    }
    if (lines[i].indent !== indent || lines[i].text.startsWith("- ")) break;
    const tok = lines[i];
    const m = tok.text.match(/^([^:]+):(?:\s+(.*))?$/);
    if (!m)
      throw new YamlError(`line ${tok.line}: cannot parse "${tok.text}" (expected "key: value")`);
    const key = parseScalar(m[1], tok.line);
    if (typeof key !== "string")
      throw new YamlError(`line ${tok.line}: mapping key must be a string`);
    const rest = (m[2] || "").trim();
    i++;
    if (rest === "") {
      const j = skipBlanks(lines, i);
      if (j < lines.length && lines[j].indent > indent) {
        [map[key], i] = parseBlock(lines, j, lines[j].indent, rawLines);
      } else {
        map[key] = null;
      }
    } else if (/^[|>][+-]?$/.test(rest)) {
      [map[key], i] = readBlockScalar(lines, i, indent, rest, rawLines);
    } else {
      map[key] = parseScalar(rest, tok.line);
    }
  }
  return [map, i];
}

/** Parses consecutive "- item" lines at one indent. An item whose text is a
 * "key: value" opens an inline mapping, e.g. "- name: Run tests". */
export function parseSequence(
  lines: Token[],
  i: number,
  indent: number,
  rawLines: string[],
): [any[], number] {
  const arr: any[] = [];
  while (i < lines.length) {
    if (lines[i].blank) {
      i++;
      continue;
    }
    if (lines[i].indent !== indent || !(lines[i].text.startsWith("- ") || lines[i].text === "-"))
      break;
    const tok = lines[i];
    const rest = tok.text === "-" ? "" : tok.text.slice(2).trim();
    i++;
    if (rest === "") {
      const j = skipBlanks(lines, i);
      if (j < lines.length && lines[j].indent > indent) {
        let val: any;
        [val, i] = parseBlock(lines, j, lines[j].indent, rawLines);
        arr.push(val);
      } else {
        arr.push(null);
      }
    } else if (/^[|>][+-]?$/.test(rest)) {
      let val: string;
      [val, i] = readBlockScalar(lines, i, indent, rest, rawLines);
      arr.push(val);
    } else if (/^[^:]+:(\s|$)/.test(rest)) {
      // Continuation keys may sit at any indent deeper than the dash; align
      // the virtual first line with them (or dash+2 when the item ends here).
      const j = skipBlanks(lines, i);
      const childIndent =
        j < lines.length && lines[j].indent > indent ? lines[j].indent : indent + 2;
      const combined: Token[] = [
        { blank: false, indent: childIndent, text: rest, raw: tok.raw, line: tok.line },
        ...lines.slice(i),
      ];
      const [val, next] = parseMapping(combined, 0, childIndent, rawLines);
      i += next - 1; // first combined element was the virtual inline line
      arr.push(val);
    } else {
      arr.push(parseScalar(rest, tok.line));
    }
  }
  return [arr, i];
}
