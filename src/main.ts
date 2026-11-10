import { run, type Work } from "./run.ts";
import { warn } from "./warnings.ts";

export async function main(work: Work, budgetMs?: number): Promise<never> {
  const bail = () => {
    warn("internal_error");
    process.exit(0);
  };
  process.on("uncaughtException", bail);
  process.on("unhandledRejection", bail);
  await run(work, budgetMs);
  process.exit(0);
}
