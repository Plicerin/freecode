import { describe, expect, test } from "bun:test";
import { formatDebugLine } from "../src/utils/debug";

describe("debug output redaction", () => {
  test("never emits API keys embedded in URLs or payloads", () => {
    const google = "AIza" + "A".repeat(35);
    const openai = "sk-proj-" + "B".repeat(30);
    const line = formatDebugLine("warn", "request failed", {
      url: `https://example.test/run?key=${google}`,
      raw: { apiKey: openai },
    });
    expect(line).not.toContain(google);
    expect(line).not.toContain(openai);
    expect(line).toContain("[REDACTED:google-key]");
    expect(line).toContain("[REDACTED:openai-key]");
  });
});
