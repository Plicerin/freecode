import { test, expect, describe } from "bun:test";
import { parseImageLimit, isImageUnsupported, countImages, capImagesTo } from "../src/agent/image-cap";
import type { ChatMessage, ImagePart } from "../src/providers/types";

const img = (id: string): ImagePart => ({ mediaType: "image/png", data: `data-${id}` } as unknown as ImagePart);

describe("isImageUnsupported", () => {
  test("detects a no-vision rejection (DeepSeek et al.)", () => {
    expect(isImageUnsupported(new Error('unknown variant `image_url`, expected `text` at line 1'))).toBe(true);
    expect(isImageUnsupported(new Error("This model does not support image input"))).toBe(true);
    expect(isImageUnsupported(new Error("vision is not supported by this model"))).toBe(true);
  });
  test("does NOT fire on a count limit or unrelated errors (those go through parseImageLimit)", () => {
    expect(isImageUnsupported(new Error("supports at most 1 image per prompt"))).toBe(false);
    expect(isImageUnsupported(new Error("429 rate limit"))).toBe(false);
    expect(isImageUnsupported(new Error("context length exceeded"))).toBe(false);
  });
});

test("capImagesTo honours a note override (for the no-vision case)", () => {
  const msgs: ChatMessage[] = [{ role: "user", content: "x", images: [img("a")] }];
  const out = capImagesTo(msgs, 0, "[image not sent — no vision]");
  expect(countImages(out)).toBe(0);
  expect(out[0]!.content).toContain("no vision");
});

describe("parseImageLimit", () => {
  test("reads the limit from the kimi-style 400", () => {
    expect(parseImageLimit(new Error("Model 'moonshotai/kimi-k2.6' supports at most 1 image per prompt."))).toBe(1);
  });
  test("handles other common phrasings", () => {
    expect(parseImageLimit("up to 4 images allowed")).toBe(4);
    expect(parseImageLimit("maximum of 2 images per request")).toBe(2);
    expect(parseImageLimit("no more than 8 images")).toBe(8);
  });
  test("null for unrelated errors", () => {
    expect(parseImageLimit(new Error("rate limit exceeded"))).toBeNull();
    expect(parseImageLimit("context length exceeded")).toBeNull();
  });
});

describe("capImagesTo", () => {
  test("keeps the most recent N images, drops the rest with a note", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "look at these", images: [img("a"), img("b")] },
      { role: "assistant", content: "ok" },
    ];
    const out = capImagesTo(msgs, 1);
    expect(countImages(out)).toBe(1);
    // The kept image is the LAST one (b); the dropped one leaves a note.
    expect((out[0]!.images as ImagePart[])[0]).toEqual(img("b"));
    expect(out[0]!.content).toMatch(/1 earlier image\(s\) omitted/);
  });

  test("caps across multiple messages, newest images win", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "first", images: [img("a")] },
      { role: "user", content: "second", images: [img("b")] },
      { role: "user", content: "third", images: [img("c")] },
    ];
    const out = capImagesTo(msgs, 1);
    expect(countImages(out)).toBe(1);
    expect((out[2]!.images as ImagePart[])[0]).toEqual(img("c")); // newest kept
    expect(out[0]!.images).toBeUndefined(); // oldest dropped
    expect(out[1]!.images).toBeUndefined();
  });

  test("a limit of 0 strips every image but preserves the messages", () => {
    const msgs: ChatMessage[] = [{ role: "user", content: "x", images: [img("a"), img("b")] }];
    const out = capImagesTo(msgs, 0);
    expect(countImages(out)).toBe(0);
    expect(out.length).toBe(1);
    expect(out[0]!.content).toMatch(/2 earlier image\(s\) omitted/);
  });

  test("no-op when already within the limit", () => {
    const msgs: ChatMessage[] = [{ role: "user", content: "x", images: [img("a")] }];
    expect(capImagesTo(msgs, 4)).toEqual(msgs);
  });
});
