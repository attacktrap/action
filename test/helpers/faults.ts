import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Work } from "../../src/run.ts";

const later = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const faults = {
  throws: () => {
    throw new Error("content");
  },
  rejects: async () => {
    throw new Error("content");
  },
  hangs: () => new Promise<void>(() => {}),
  throwsLater: async () => {
    setTimeout(() => {
      throw new Error("content");
    });
    await later(5_000);
  },
  rejectsUnhandled: async () => {
    void Promise.reject(new Error("content"));
    await later(5_000);
  },
} satisfies Record<string, Work>;

export type FaultName = keyof typeof faults;

export interface EntryResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

const fixture = fileURLToPath(new URL("../fixtures/entry.ts", import.meta.url));

export function runEntry(
  fault: FaultName | "none",
  { budgetMs }: { budgetMs?: number } = {},
): Promise<EntryResult> {
  const args = [fixture, fault, ...(budgetMs === undefined ? [] : [String(budgetMs)])];
  return runNode(args);
}

export function runNode(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<EntryResult> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(process.execPath, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: performance.now() - start }));
  });
}
