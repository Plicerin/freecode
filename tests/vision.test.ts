import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractAttachments } from "../src/agent/attachments";
import { toAnthropicMessages } from "../src/providers/anthropic";
import { toGeminiContents } from "../src/providers/gemini";
import type { ChatMessage } from "../src/providers/types";

const img = { data: "QUJD", mediaType: "image/png" };
const msgs: ChatMessage[] = [{ role: "user", content: "what is this?", images: [img] }];

describe("extractAttachments", () => {
  it("reads @path image tokens into base64 ImageParts", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-img-"));
    const p = join(dir, "pic.png");
    writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic bytes
    const r = extractAttachments(`look at @${p} please`, dir);
    expect(r.images.length).toBe(1);
    expect(r.images[0]!.mediaType).toBe("image/png");
    expect(r.images[0]!.data.length).toBeGreaterThan(0);
  });
  it("ignores non-image @tokens and notes missing files", () => {
    const r = extractAttachments("@notes.txt and @missing.png", process.cwd());
    expect(r.images.length).toBe(0);
    expect(r.notes.some((n) => n.includes("not found"))).toBe(true);
  });
});

describe("provider image serialization", () => {
  it("Anthropic emits an image block", () => {
    const out = toAnthropicMessages(msgs);
    expect(out[0]!.content.some((b) => b.type === "image")).toBe(true);
  });
  it("Gemini emits an inlineData part", () => {
    const out = toGeminiContents(msgs);
    expect(out[0]!.parts.some((p) => p.inlineData?.mimeType === "image/png")).toBe(true);
  });
});
