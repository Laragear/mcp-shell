// Bounded output capture for a stage: the configured truncation shape plus
// the discarded count, and raw chunks (up to a byte cap) for piping into a
// parse stage. Chatty commands truncate instead of dying.

import type { NormalizedTruncate } from "../config/index.js";

const RAW_CHUNK_CAP = 8 * 1024 * 1024;

/**
 * Collects one output stream into bounded text plus raw chunks. The default
 * shape keeps the first `limit` characters; an explicit truncate keeps the
 * first or last `limit` characters or bytes, never cutting a multibyte
 * character in half.
 */
export function makeCollector(spec: NormalizedTruncate) {
  let text = "";
  let dropped = 0;
  const chunks: Buffer[] = [];
  let rawBytes = 0;
  let tail: Buffer = Buffer.alloc(0);
  let totalBytes = 0;
  const bytes = spec.kind === "bytes";
  const keepEnd = spec.mode === "end";

  const pushChars = (s: string) => {
    if (keepEnd && spec.kind === "chars") {
      text += s;
      if (text.length > spec.limit) {
        dropped += text.length - spec.limit;
        text = text.slice(text.length - spec.limit);
      }
      return;
    }
    if (text.length >= spec.limit) {
      dropped += s.length;
      return;
    }
    text += s;
    if (text.length > spec.limit) {
      dropped += text.length - spec.limit;
      text = text.slice(0, spec.limit);
    }
  };

  // Drops continuation bytes left at the start of a buffer when a tail cut
  // fell inside a multibyte sequence.
  const stripLeadingFragment = (b: Buffer): Buffer => {
    let at = 0;
    while (at < b.length && (b[at] & 0xc0) === 0x80) at++;
    return b.subarray(at);
  };

  // Drops an incomplete trailing sequence when a head cut fell inside one.
  const stripTrailingFragment = (b: Buffer): Buffer => {
    let continuations = 0;
    while (continuations < b.length && (b[b.length - 1 - continuations] & 0xc0) === 0x80) {
      continuations++;
    }
    const lead = b.length - 1 - continuations;
    if (lead < 0) return Buffer.alloc(0);
    const first = b[lead];
    const expected = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
    return b.length - lead < expected ? b.subarray(0, lead) : b;
  };

  return {
    push(chunk: Buffer) {
      if (rawBytes < RAW_CHUNK_CAP) {
        chunks.push(Buffer.from(chunk));
        rawBytes += chunk.length;
      }
      if (bytes) {
        totalBytes += chunk.length;
        tail = Buffer.concat([tail, chunk]);
        if (tail.length > spec.limit) {
          tail = keepEnd
            ? stripLeadingFragment(tail.subarray(tail.length - spec.limit))
            : stripTrailingFragment(tail.subarray(0, spec.limit));
        }
        return;
      }
      pushChars(chunk.toString("utf8"));
    },
    text: () => {
      const body = bytes ? stripLeadingFragment(tail).toString("utf8") : text;
      const discarded = bytes ? totalBytes - Buffer.byteLength(body, "utf8") : dropped;
      const unit = bytes ? "bytes" : "characters";
      return discarded ? `${body}\n…[truncated, ${discarded} more ${unit} discarded]` : body;
    },
    chunks: () => chunks,
  };
}
