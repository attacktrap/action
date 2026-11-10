import { spawn } from "node:child_process";
import { warn, type WarningCode } from "./warnings.ts";

export const BUDGET_MS = 30_000;
const EXIT_MARGIN_MS = 500;
const WORKER_FLAG = "--work";

export type Work = () => Promise<void>;

export async function main(work: Work, { budgetMs = BUDGET_MS } = {}): Promise<void> {
  if (process.argv.includes(WORKER_FLAG)) {
    await work();
    process.exit(0);
  }
  supervise(budgetMs);
}

function supervise(budgetMs: number): void {
  const finish = (code?: WarningCode): never => {
    if (code) warn(code);
    process.exit(0);
  };
  process.on("uncaughtException", () => finish("internal_error"));
  process.on("unhandledRejection", () => finish("internal_error"));
  try {
    const args = [...process.execArgv, process.argv[1], ...process.argv.slice(2), WORKER_FLAG];
    const child = spawn(process.execPath, args, { stdio: ["ignore", "inherit", "ignore"] });
    setTimeout(
      () => {
        child.kill("SIGKILL");
        finish("timed_out");
      },
      Math.max(0, budgetMs - EXIT_MARGIN_MS - performance.now()),
    );
    child.on("error", () => finish("internal_error"));
    child.on("exit", (code) => finish(code === 0 ? undefined : "internal_error"));
  } catch {
    finish("internal_error");
  }
}
