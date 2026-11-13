import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, type TestContext } from "vitest";
import { findCheckout, writeInside, type Checkout } from "../src/workspace.ts";
import { makeTree } from "./helpers/tree.ts";

// A workspace `w/` beside an empty `outside/`, so a test can show nothing landed outside.
async function setup(files: Record<string, string> = { "w/a/x.txt": "content" }) {
  const top = makeTree(files);
  const outside = path.join(top, "outside");
  mkdirSync(outside, { recursive: true });
  const checkout = (await findCheckout(path.join(top, "w"))) as Checkout;
  return { top, outside, checkout, root: checkout.root };
}

const read = (...p: string[]) => readFileSync(path.join(...p), "utf8");

// Junctions need no symlink rights on Windows.
const linkDir = (target: string, link: string) => symlinkSync(target, link, "junction");

// File symlinks do need them, so skip where the runner lacks them.
function linkFile(ctx: TestContext, target: string, link: string): void {
  try {
    symlinkSync(target, link, "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") ctx.skip("creating a file symlink needs symlink rights");
    throw error;
  }
}

describe("writeInside", () => {
  it.each([
    ["a/b.txt", ["a", "b.txt"]],
    ["b.txt", ["b.txt"]],
    ["..b.txt", ["..b.txt"]],
  ])("writes %s", async (rel, at) => {
    const { root, checkout } = await setup();
    expect(await writeInside(checkout, rel, "content")).toBe("written");
    expect(read(root, ...at)).toBe("content");
  });

  it("writes into a workspace reached through a symlink", async () => {
    const { top } = await setup();
    const link = path.join(mkdtempSync(path.join(tmpdir(), "link-")), "w");
    linkDir(path.join(top, "w"), link);
    const checkout = (await findCheckout(link)) as Checkout;
    expect(await writeInside(checkout, "a/b.txt", "content")).toBe("written");
    expect(read(top, "w", "a", "b.txt")).toBe("content");
  });

  it("follows a symlinked directory that stays inside", async () => {
    const { root, checkout } = await setup({ "w/d/x.txt": "content" });
    linkDir(path.join(root, "d"), path.join(root, "a"));
    expect(await writeInside(checkout, "a/b.txt", "content")).toBe("written");
    expect(read(root, "d", "b.txt")).toBe("content");
  });

  it("leaves an existing file alone", async () => {
    const { root, checkout } = await setup({ "w/a/b.txt": "existing" });
    expect(await writeInside(checkout, "a/b.txt", "content")).toBe("path_exists");
    expect(read(root, "a", "b.txt")).toBe("existing");
  });

  it("leaves an existing directory alone", async () => {
    const { root, checkout } = await setup({ "w/a/b.txt/x.txt": "content" });
    expect(await writeInside(checkout, "a/b.txt", "content")).toBe("path_exists");
    expect(readdirSync(path.join(root, "a", "b.txt"))).toEqual(["x.txt"]);
  });

  it("never follows a symlink at the final name to an outside file", async (ctx) => {
    const { root, outside, checkout } = await setup();
    writeFileSync(path.join(outside, "f.txt"), "existing");
    linkFile(ctx, path.join(outside, "f.txt"), path.join(root, "a", "b.txt"));
    expect(await writeInside(checkout, "a/b.txt", "content")).toBe("path_exists");
    expect(read(outside, "f.txt")).toBe("existing");
  });

  it("never follows a dangling symlink at the final name", async (ctx) => {
    const { root, outside, checkout } = await setup();
    linkFile(ctx, path.join(outside, "f.txt"), path.join(root, "a", "b.txt"));
    expect(await writeInside(checkout, "a/b.txt", "content")).toBe("path_exists");
    expect(readdirSync(outside)).toEqual([]);
  });

  it.each<[string, (s: { outside: string }) => string]>([
    ["a parent escape", () => "../b.txt"],
    ["a nested escape", () => "a/../../b.txt"],
    ["a sibling that shares the workspace's name", () => "../w-other/b.txt"],
    ["an absolute path outside", ({ outside }) => path.join(outside, "b.txt")],
    ["a POSIX absolute path", () => "/b.txt"],
    ["a drive path", () => "C:\\b.txt"],
    ["a UNC path", () => "\\\\host\\share\\b.txt"],
    ["the workspace itself", () => "."],
    ["the workspace itself via a/..", () => "a/.."],
  ])("refuses %s", async (_, rel) => {
    const s = await setup({ "w/a/x.txt": "content", "w-other/x.txt": "content" });
    const before = readdirSync(s.top).sort();
    expect(await writeInside(s.checkout, rel(s), "content")).toBe("write_failed");
    expect(readdirSync(s.outside)).toEqual([]);
    expect(readdirSync(path.join(s.top, "w-other"))).toEqual(["x.txt"]);
    expect(readdirSync(s.top).sort()).toEqual(before);
  });

  it("never creates a missing parent", async () => {
    const { root, checkout } = await setup();
    expect(await writeInside(checkout, "c/b.txt", "content")).toBe("write_failed");
    expect(existsSync(path.join(root, "c"))).toBe(false);
  });

  it("fails when the parent is a file", async () => {
    const { root, checkout } = await setup({ "w/a.txt": "existing" });
    expect(await writeInside(checkout, "a.txt/b.txt", "content")).toBe("write_failed");
    expect(read(root, "a.txt")).toBe("existing");
  });

  it("fails on a NUL byte", async () => {
    const { root, checkout } = await setup();
    expect(await writeInside(checkout, "a/b\0.txt", "content")).toBe("write_failed");
    expect(readdirSync(path.join(root, "a"))).toEqual(["x.txt"]);
  });

  it("refuses a symlinked directory that leads outside", async () => {
    const { root, outside, checkout } = await setup({ "w/x.txt": "content" });
    linkDir(outside, path.join(root, "a"));
    expect(await writeInside(checkout, "a/b.txt", "content")).toBe("write_failed");
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses a directory below a symlink that leads outside", async () => {
    const { root, outside, checkout } = await setup({ "w/x.txt": "content" });
    mkdirSync(path.join(outside, "c"));
    linkDir(outside, path.join(root, "a"));
    expect(await writeInside(checkout, "a/c/b.txt", "content")).toBe("write_failed");
    expect(readdirSync(path.join(outside, "c"))).toEqual([]);
  });

  it.runIf(process.platform === "win32").each([["a\\..\\..\\b.txt"], ["C:b.txt"]])("refuses %s on Windows", async (rel) => {
    const { outside, checkout } = await setup();
    expect(await writeInside(checkout, rel, "content")).toBe("write_failed");
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe("findCheckout", () => {
  it.each<[string, () => string | undefined]>([
    ["unset", () => undefined],
    ["empty", () => ""],
    ["missing", () => path.join(tmpdir(), "missing-a")],
    ["a file", () => path.join(makeTree({ "x.txt": "content" }), "x.txt")],
    ["an empty directory", () => mkdtempSync(path.join(tmpdir(), "empty-"))],
  ])("is no_checkout when the workspace is %s", async (_, dir) => {
    expect(await findCheckout(dir())).toBe("no_checkout");
  });

  it("gives the real path of a workspace reached through a symlink", async () => {
    const real = makeTree({ "x.txt": "content" });
    const link = path.join(mkdtempSync(path.join(tmpdir(), "link-")), "w");
    linkDir(real, link);
    expect(await findCheckout(link)).toEqual({ root: realpathSync.native(real) });
  });
});
