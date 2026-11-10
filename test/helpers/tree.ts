import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function makeTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "project-"));
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(root, ...file.split("/"));
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}
