// Last-known-good recall cache: so memory degrades to "slightly stale" instead
// of "gone" when Honcho is briefly slow/unreachable at session start (the
// "recalled something one session, nothing the next" symptom).
import { test, expect, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMemoryCache, writeMemoryCache } from "../src/memory/cache";

const tmp = () => join(mkdtempSync(join(tmpdir(), "oc-memcache-")), "memory-cache.json");

describe("memory cache", () => {
  test("round-trips the last good block per workspace", () => {
    const p = tmp();
    expect(readMemoryCache("freecode", p)).toBeNull();
    writeMemoryCache("freecode", "## memory\nknows the project", p);
    expect(readMemoryCache("freecode", p)).toContain("knows the project");
  });

  test("is keyed by workspace", () => {
    const p = tmp();
    writeMemoryCache("freecode", "A", p);
    writeMemoryCache("other", "B", p);
    expect(readMemoryCache("freecode", p)).toBe("A");
    expect(readMemoryCache("other", p)).toBe("B");
  });

  test("never caches an empty block over a good one (a bad recall can't erase memory)", () => {
    const p = tmp();
    writeMemoryCache("freecode", "good memory", p);
    writeMemoryCache("freecode", "   ", p); // an empty recall must NOT overwrite
    expect(readMemoryCache("freecode", p)).toBe("good memory");
  });

  test("returns null for an unknown workspace", () => {
    const p = tmp();
    writeMemoryCache("freecode", "x", p);
    expect(readMemoryCache("nope", p)).toBeNull();
  });

  test("different project scopes under one workspace don't collide (the cross-project leak)", () => {
    const p = tmp();
    writeMemoryCache("freecode::remote:github.com/o/a", "A", p);
    writeMemoryCache("freecode::remote:github.com/o/b", "B", p);
    expect(readMemoryCache("freecode::remote:github.com/o/a", p)).toBe("A");
    expect(readMemoryCache("freecode::remote:github.com/o/b", p)).toBe("B");
    // a workspace-only key (the old global behavior) matches neither project
    expect(readMemoryCache("freecode", p)).toBeNull();
  });
});
