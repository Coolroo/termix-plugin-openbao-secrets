import { describe, expect, it } from "vitest";
import { applyMaskedEdit, MASK, maskOf } from "../../src/frontend/mask";

/** Runs an edit the way a textarea would: on the masked text. */
function edit(real: string, start: number, end: number, typed: string): string {
  const shown = maskOf(real);
  const next = shown.slice(0, start) + typed + shown.slice(end);
  return applyMaskedEdit(real, shown, next, start + typed.length);
}

describe("the masked field", () => {
  it("shows one dot per character and keeps line breaks", () => {
    expect(maskOf("ab\ncd")).toBe(`${MASK}${MASK}\n${MASK}${MASK}`);
    expect(maskOf("")).toBe("");
    expect(maskOf("🔑x")).toBe(`${MASK}${MASK}`);
  });

  it("follows typing, paste, replace and delete anywhere", () => {
    expect(edit("", 0, 0, "a")).toBe("a");
    expect(edit("ac", 1, 1, "b")).toBe("abc");
    expect(edit("abc", 0, 0, "X")).toBe("Xabc");
    expect(edit("abcd", 1, 3, "Z")).toBe("aZd");
    expect(edit("abcd", 1, 3, "")).toBe("ad");
    expect(edit("abcd", 3, 4, "")).toBe("abc");
    expect(edit("ab", 2, 2, "-----BEGIN\nKEY\n-----END")).toBe(
      "ab-----BEGIN\nKEY\n-----END",
    );
  });

  it("puts a line break where it was typed, even beside another", () => {
    expect(edit("ab\ncd", 2, 2, "\n")).toBe("ab\n\ncd");
    expect(edit("ab\ncd", 3, 3, "\n")).toBe("ab\n\ncd");
    expect(edit("ab\ncd", 2, 3, "")).toBe("abcd");
  });

  it("keeps characters outside the Basic Multilingual Plane whole", () => {
    expect(edit("a🔑b", 2, 3, "")).toBe("a🔑");
    expect(edit("a🔑b", 1, 2, "")).toBe("ab");
    expect(edit("a", 1, 1, "🔑")).toBe("a🔑");
  });

  it("takes a typed dot as a real character", () => {
    expect(edit("ab", 1, 1, MASK)).toBe(`a${MASK}b`);
  });
});
