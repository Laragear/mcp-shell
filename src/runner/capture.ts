// Bounded output capture for a stage: at most maxChars characters plus the
// discarded count, and raw chunks (up to a byte cap) for piping into a parse
// stage. Chatty commands truncate instead of dying.

const RAW_CHUNK_CAP = 8 * 1024 * 1024;

/**
 * Collects one output stream into bounded text plus raw chunks.
 */
export function makeCollector(maxChars: number) {
  let text = "";
  let dropped = 0;
  const chunks: Buffer[] = [];
  let rawBytes = 0;
  return {
    push(chunk: Buffer) {
      if (rawBytes < RAW_CHUNK_CAP) {
        chunks.push(Buffer.from(chunk));
        rawBytes += chunk.length;
      }
      const s = chunk.toString("utf8");
      if (text.length >= maxChars) {
        dropped += s.length;
        return;
      }
      text += s;
      if (text.length > maxChars) {
        dropped += text.length - maxChars;
        text = text.slice(0, maxChars);
      }
    },
    text: () => (dropped ? `${text}\n…[truncated, ${dropped} more characters discarded]` : text),
    chunks: () => chunks,
  };
}
