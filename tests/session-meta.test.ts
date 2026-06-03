import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  newSession,
  appendEvent,
  setSessionTitle,
  listSessionMetas,
  titleOf,
  readSession,
} from "../src/session/manager";

const iso = () => new Date().toISOString();

test("session metadata exposes title, preview, and count for the picker", () => {
  const cwd = `/freecode-meta-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const s = newSession(cwd);
  try {
    appendEvent(s, { kind: "user", text: "  first   prompt here  ", ts: iso() });
    appendEvent(s, { kind: "assistant", text: "ok", ts: iso() });
    appendEvent(s, { kind: "user", text: "second", ts: iso() });

    let metas = listSessionMetas(cwd);
    expect(metas).toHaveLength(1);
    expect(metas[0]!.preview).toBe("first prompt here"); // whitespace collapsed/trimmed
    expect(metas[0]!.count).toBe(3); // 2 user + 1 assistant (title/system excluded)
    expect(metas[0]!.title).toBeUndefined();

    setSessionTitle(s, "My Session");
    metas = listSessionMetas(cwd);
    expect(metas[0]!.title).toBe("My Session");

    // latest title wins (so /rename can be run repeatedly)
    setSessionTitle(s, "Renamed Again");
    expect(titleOf(readSession(s))).toBe("Renamed Again");
  } finally {
    rmSync(dirname(s.path), { recursive: true, force: true });
  }
});

test("listSessionMetas sorts newest-first", () => {
  const base = `/freecode-sort-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const a = newSession(base);
  appendEvent(a, { kind: "user", text: "older", ts: iso() });
  // a tiny spin so mtimes differ on fast filesystems
  for (let i = 0; i < 1e5; i++) void i;
  const b = newSession(base);
  appendEvent(b, { kind: "user", text: "newer", ts: iso() });
  try {
    const metas = listSessionMetas(base);
    expect(metas.length).toBeGreaterThanOrEqual(2);
    expect(metas[0]!.mtime).toBeGreaterThanOrEqual(metas[1]!.mtime);
  } finally {
    rmSync(dirname(a.path), { recursive: true, force: true });
  }
});
