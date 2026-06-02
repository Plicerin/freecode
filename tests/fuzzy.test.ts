import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editDistance, closest } from "../src/utils/fuzzy";
import { extractAttachments } from "../src/agent/attachments";

describe("fuzzy", () => {
  it("computes edit distance", () => {
    expect(editDistance("compact", "compcat")).toBe(2);
    expect(editDistance("same", "same")).toBe(0);
  });
  it("finds the closest command", () => {
    const cmds = ["/compact", "/context", "/provider", "/model"];
    expect(closest("/compcat", cmds, 3)).toBe("/compact");
    expect(closest("/conext", cmds, 3)).toBe("/context");
    expect(closest("/zzzzzz", cmds, 3)).toBeUndefined(); // too far
  });
});

describe("@path not-found suggestion", () => {
  it("suggests the nearest existing image filename", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-fz-"));
    writeFileSync(join(dir, "screenshot.png"), Buffer.from([0x89, 0x50]));
    const r = extractAttachments("look at @screenshat.png", dir);
    expect(r.images.length).toBe(0);
    expect(r.notes.some((n) => n.includes("did you mean screenshot.png"))).toBe(true);
  });
});
