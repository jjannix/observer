import { describe, expect, it } from "vitest";
import { shouldSkipSourceFile } from "../../src/server/sync/engine.js";

const base = { currentPath: "C:/data/opencode.db", size: 20480, mtimeMs: 1786724102585.449, byteCursor: 20480 };

describe("source-file skip decision", () => {
  it("skips a file whose signature and cursor are unchanged", () => {
    expect(
      shouldSkipSourceFile(base, { path: base.currentPath, size: base.size, mtimeMs: base.mtimeMs }),
    ).toBe(true);
  });

  it("skips when the cursor reached beyond the file size with an identical signature", () => {
    expect(
      shouldSkipSourceFile(
        { ...base, byteCursor: 32768 },
        { path: base.currentPath, size: base.size, mtimeMs: base.mtimeMs },
      ),
    ).toBe(true);
  });

  it("collects when the size changed (WAL growth, appended lines)", () => {
    expect(
      shouldSkipSourceFile(base, { path: base.currentPath, size: base.size + 1024, mtimeMs: base.mtimeMs + 5 }),
    ).toBe(false);
  });

  it("collects when only the mtime changed (in-place page rewrite)", () => {
    expect(
      shouldSkipSourceFile(base, { path: base.currentPath, size: base.size, mtimeMs: base.mtimeMs + 0.4 }),
    ).toBe(false);
  });

  it("collects when the file shrank below the consumed cursor (vacuum)", () => {
    expect(
      shouldSkipSourceFile(
        { ...base, size: 40960, byteCursor: 40960 },
        { path: base.currentPath, size: 20480, mtimeMs: base.mtimeMs },
      ),
    ).toBe(false);
  });

  it("collects when the cursor never reached the file size", () => {
    expect(
      shouldSkipSourceFile(
        { ...base, byteCursor: 500 },
        { path: base.currentPath, size: base.size, mtimeMs: base.mtimeMs },
      ),
    ).toBe(false);
  });

  it("collects when the file moved (path identity changed)", () => {
    expect(
      shouldSkipSourceFile(base, { path: "C:/archived/opencode.db", size: base.size, mtimeMs: base.mtimeMs }),
    ).toBe(false);
  });

  it("collects a first-time file and empty files", () => {
    expect(shouldSkipSourceFile(undefined, { path: base.currentPath, size: 10, mtimeMs: 1 })).toBe(false);
    expect(
      shouldSkipSourceFile({ ...base, size: 0, byteCursor: 0 }, { path: base.currentPath, size: 0, mtimeMs: 1 }),
    ).toBe(false);
  });
});
