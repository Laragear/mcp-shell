// Output checking: the per-command `check` rules. Every present rule must
// pass (AND).

import { compileMultilineRegex } from "../support.js";
import type { CheckSpec } from "../config/index.js";

/**
 * Coerces a rule value (string or list of strings) into a list.
 */
function asList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : v !== undefined && v !== null ? [String(v)] : [];
}

/**
 * The shared reason format for a regex rule that must (not) match.
 */
function regexReason(
  text: string,
  rule: string,
  pattern: string,
  forbidden: boolean,
): string | null {
  const compiled = compileMultilineRegex(pattern);
  if ("error" in compiled) return `invalid ${rule} ${JSON.stringify(pattern)}: ${compiled.error}`;
  const matched = compiled.test(text);
  if (forbidden && matched) return `matches forbidden regex /${pattern}/`;
  if (!forbidden && !matched) return `does not match regex /${pattern}/`;
  return null;
}

/** Evaluates every check rule against the output; reasons lists why it
 * failed, empty when the output passes. */
export function matchOutput(text: string, spec: CheckSpec): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const needle of asList((spec as any).contains)) {
    if (!text.includes(needle)) reasons.push(`does not contain "${needle}"`);
  }
  for (const needle of asList((spec as any).not_contains)) {
    if (text.includes(needle)) reasons.push(`contains forbidden "${needle}"`);
  }
  for (const pattern of asList((spec as any).regex)) {
    const reason = regexReason(text, "regex", pattern, false);
    if (reason) reasons.push(reason);
  }
  for (const pattern of asList((spec as any).not_regex)) {
    const reason = regexReason(text, "not_regex", pattern, true);
    if (reason) reasons.push(reason);
  }
  return { ok: reasons.length === 0, reasons };
}
