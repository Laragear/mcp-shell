import { describe, expect, it } from "vitest";
import { makeCollector } from "../../src/runner/capture.js";

describe("makeCollector", () => {
  it("keeps counting discarded characters after the cap", () => {
    const c = makeCollector({ kind: "default", mode: "start", limit: 5 });
    c.push(Buffer.from("12345"));
    c.push(Buffer.from("67890"));
    c.push(Buffer.from("extra"));
    expect(c.text()).toBe("12345\n…[truncated, 10 more characters discarded]");
  });

  it("keeps the last characters with mode end", () => {
    const c = makeCollector({ kind: "chars", mode: "end", limit: 5 });
    c.push(Buffer.from("12345"));
    c.push(Buffer.from("67890"));
    c.push(Buffer.from("extra"));
    expect(c.text()).toBe("extra\n…[truncated, 10 more characters discarded]");
  });

  it("keeps the first bytes and never cuts a multibyte character", () => {
    const c = makeCollector({ kind: "bytes", mode: "start", limit: 4 });
    c.push(Buffer.from("ééé", "utf8"));
    expect(c.text()).toBe("éé\n…[truncated, 2 more bytes discarded]");
  });

  it("keeps the last bytes and never cuts a multibyte character", () => {
    const c = makeCollector({ kind: "bytes", mode: "end", limit: 4 });
    c.push(Buffer.from("ááá", "utf8"));
    expect(c.text()).toBe("áá\n…[truncated, 2 more bytes discarded]");
  });

  it("drops a lone continuation byte left by a tail cut", () => {
    const c = makeCollector({ kind: "bytes", mode: "end", limit: 3 });
    c.push(Buffer.from("ááá", "utf8"));
    expect(c.text()).toBe("á\n…[truncated, 4 more bytes discarded]");
  });

  it("cuts an incomplete trailing byte sequence", () => {
    const c = makeCollector({ kind: "bytes", mode: "start", limit: 2 });
    c.push(Buffer.from([0x61])); // "a"
    c.push(Buffer.from([0xc3, 0xa1])); // "á": the cut lands between lead and continuation
    expect(c.text()).toBe("a\n…[truncated, 2 more bytes discarded]");
  });

  it("cuts a 3-byte sequence without leaving fragments", () => {
    const c = makeCollector({ kind: "bytes", mode: "start", limit: 2 });
    c.push(Buffer.from("a…", "utf8"));
    expect(c.text()).toBe("a\n…[truncated, 3 more bytes discarded]");
  });

  it("cuts a 4-byte sequence without leaving fragments", () => {
    const c = makeCollector({ kind: "bytes", mode: "start", limit: 3 });
    c.push(Buffer.from("a😀", "utf8"));
    expect(c.text()).toBe("a\n…[truncated, 4 more bytes discarded]");
  });

  it("keeps everything when the limit is larger than the output", () => {
    const c = makeCollector({ kind: "chars", mode: "end", limit: 100 });
    c.push(Buffer.from("small"));
    expect(c.text()).toBe("small");
    const b = makeCollector({ kind: "bytes", mode: "end", limit: 100 });
    b.push(Buffer.from("small"));
    expect(b.text()).toBe("small");
  });

  it("stops keeping raw chunks past the byte cap", () => {
    const c = makeCollector({ kind: "default", mode: "start", limit: 100 });
    c.push(Buffer.alloc(8 * 1024 * 1024, 0x61));
    c.push(Buffer.from("more"));
    expect(c.chunks()).toHaveLength(1);
    expect(c.text()).toContain("more");
  });
});
