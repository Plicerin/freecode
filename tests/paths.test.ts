import { describe, expect, test } from "bun:test";
import { encodeProjectPath } from "../src/utils/paths";

describe("project path encoding", () => {
  test("paths that collided under separator replacement now have distinct slugs", () => {
    expect(encodeProjectPath("C:\\work\\a-b")).not.toBe(encodeProjectPath("C:\\work\\a\\b"));
  });

  test("slug is a portable single path component", () => {
    expect(encodeProjectPath("C:\\Users\\Jane Doe\\demo")).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});
