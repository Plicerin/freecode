// Some models accept only a limited number of images per request (e.g.
// moonshotai/kimi-k2.6 → "supports at most 1 image per prompt"), and reject the
// WHOLE request with a 400 when exceeded — which isn't retryable, so a turn that
// loaded two images would dead-end. We learn the limit from the provider's own
// error and cap the conversation to the most-recent N images, keeping the rest
// as a text note so the model knows they exist (and can view them one at a time).
import type { ChatMessage } from "../providers/types";

/** Pull a per-request image limit out of a provider error message, or null if it
 *  isn't an image-count complaint. Matches the common phrasings providers use. */
export function parseImageLimit(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const patterns = [
    /at most (\d+)\s+image/i,
    /up to (\d+)\s+image/i,
    /maximum (?:of )?(\d+)\s+image/i,
    /no more than (\d+)\s+image/i,
    /(\d+)\s+images? (?:per|maximum|max|allowed)/i,
  ];
  for (const re of patterns) {
    const m = msg.match(re);
    if (m) return Math.max(0, Number.parseInt(m[1]!, 10));
  }
  return null;
}

/** True when a provider rejects the request because the model has NO vision at
 *  all (not a count limit) — e.g. DeepSeek: "unknown variant `image_url`,
 *  expected `text`". The fix is to strip ALL images (cap 0), not just trim to N.
 *  Once one lands in the history it poisons every later request, so we detect and
 *  remove it. */
export function isImageUnsupported(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    /unknown variant .{0,2}image_url/.test(m) || // deserialize error (deepseek et al.)
    /does not support (image|vision)/.test(m) ||
    /(image|vision).{0,24}(is )?not supported/.test(m) ||
    /image input is not/.test(m) ||
    /no support for image/.test(m) ||
    (/image_url/.test(m) && /expected .{0,2}text/.test(m))
  );
}

/** Count image parts across a conversation. */
export function countImages(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + (m.images?.length ?? 0), 0);
}

/** Return a copy of `messages` carrying at most `limit` images — keeping the
 *  MOST RECENT ones (the latest view is usually what matters) and replacing the
 *  dropped image parts with a text note so the model still knows they existed. */
export function capImagesTo(messages: ChatMessage[], limit: number, noteOverride?: string): ChatMessage[] {
  const cap = Math.max(0, limit);
  let kept = 0;
  const out: ChatMessage[] = [];
  // Walk newest → oldest so the kept images are the latest.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const imgs = m.images;
    if (!imgs || imgs.length === 0) { out.unshift(m); continue; }
    const room = Math.max(0, cap - kept);
    if (room >= imgs.length) {
      kept += imgs.length;
      out.unshift(m);
      continue;
    }
    const keepImgs = room > 0 ? imgs.slice(imgs.length - room) : [];
    kept += keepImgs.length;
    const dropped = imgs.length - keepImgs.length;
    const note = noteOverride ?? `[${dropped} earlier image(s) omitted — this model accepts at most ${cap} image(s) per request; view them one at a time if you need them]`;
    out.unshift({
      ...m,
      images: keepImgs.length ? keepImgs : undefined,
      content: m.content ? `${m.content}\n${note}` : note,
    });
  }
  return out;
}
