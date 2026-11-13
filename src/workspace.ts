import { lstat, open, readdir, realpath, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";

/** A workspace that exists and has at least one entry. `root` is its real path. */
export type Checkout = { readonly root: string };

/** The result of a write, which is also the status the Action reports for it. */
export type WriteStatus = "written" | "path_exists" | "write_failed";

export async function findCheckout(dir: string | undefined): Promise<Checkout | "no_checkout"> {
  if (!dir) return "no_checkout";
  try {
    const root = await realpath(dir);
    return (await readdir(root)).length > 0 ? { root } : "no_checkout";
  } catch {
    return "no_checkout";
  }
}

/**
 * Creates `rel` inside the checkout holding `content`. Never creates directories, never follows
 * or replaces anything at the final name, never writes outside the checkout's real path, and
 * never throws.
 */
export async function writeInside(checkout: Checkout, rel: string, content: string): Promise<WriteStatus> {
  const { root } = checkout;
  // Both flavours, so `/a`, `C:\a` and `\\h\s\a` are refused alike on every runner.
  if (path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel)) return "write_failed";
  const target = path.resolve(root, rel);
  if (!inside(root, target)) return "write_failed";

  let parent: string;
  try {
    parent = await realpath(path.dirname(target));
  } catch {
    return "write_failed";
  }
  if (parent !== root && !inside(root, parent)) return "write_failed";
  const file = path.join(parent, path.basename(target));

  let handle: FileHandle;
  try {
    handle = await open(file, "wx");
  } catch {
    // `wx` fails on anything already at the name, a symlink included, with an error code that
    // differs by platform, so judge by what is there.
    return (await exists(file)) ? "path_exists" : "write_failed";
  }
  try {
    await handle.writeFile(content);
    await handle.close();
    return "written";
  } catch {
    await handle.close().catch(() => {});
    await rm(file, { force: true }).catch(() => {});
    return "write_failed";
  }
}

// Strictly below `root`. Both sides come from the same realpath, so case and separators agree.
function inside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel !== "" && !path.isAbsolute(rel) && rel.split(path.sep)[0] !== "..";
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}
