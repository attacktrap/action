import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Work } from "../../src/main.ts";

const later = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const faults = {
  throws: () => {
    throw new Error("fault content");
  },
  rejects: async () => {
    throw new Error("fault content");
  },
  hangs: () =>
    new Promise<void>(() => {
      setInterval(() => {}, 1_000);
    }),
  spins: () => {
    for (;;) {}
  },
  throwsLater: async () => {
    setTimeout(() => {
      throw new Error("fault content");
    });
    await later(5_000);
  },
  rejectsUnhandled: async () => {
    void Promise.reject(new Error("fault content"));
    await later(5_000);
  },
  exits: async () => {
    process.exit(1);
  },
  breaksStdout: async () => {
    process.stdout.write = () => {
      throw new Error("fault content");
    };
    throw new Error("fault content");
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

export function runNode(args: string[], env: NodeJS.ProcessEnv = process.env, { readAfterMs = 0 } = {}): Promise<EntryResult> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(process.execPath, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    if (readAfterMs > 0) {
      child.stdout.pause();
      setTimeout(() => child.stdout.resume(), readAfterMs);
    }
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: performance.now() - start }));
  });
}
