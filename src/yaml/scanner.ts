// Scanner: raw text into indented line tokens. Blank lines become tokens so
// block scalars can contain them; every parser loop skips blanks explicitly.

export class YamlError extends Error {}

export interface Token {
  blank: boolean;
  indent: number;
  text: string;
  raw: string;
  line: number;
}

/**
 * Removes a trailing comment, honoring quoted strings.
 */
function stripComment(line: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      out += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
    } else if (ch === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      break;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Splits the document into line tokens, carrying indent, trimmed text and
 * the raw line; rejects tab indentation and skips document separators. */
export function tokenize(text: string): Token[] {
  const lines: Token[] = [];
  text.split("\n").forEach((raw, idx) => {
    const lineNo = idx + 1;
    const noComment = stripComment(raw);
    const trimmed = noComment.trim();
    if (trimmed === "---") return;
    if (trimmed === "") {
      lines.push({ blank: true, indent: 0, text: "", raw, line: lineNo });
      return;
    }
    if (/^\t/.test(noComment)) {
      throw new YamlError(`line ${lineNo}: tab character in indentation (use spaces)`);
    }
    lines.push({
      blank: false,
      indent: (noComment.match(/^ */) as RegExpMatchArray)[0].length,
      text: trimmed,
      raw,
      line: lineNo,
    });
  });
  return lines;
}

/**
 * Advances past blank tokens; returns the index of the next content line.
 */
export function skipBlanks(lines: Token[], i: number): number {
  while (i < lines.length && lines[i].blank) i++;
  return i;
}
