import { warn } from "./warnings.ts";

export const BUDGET_MS = 30_000;

export type Work = (signal: AbortSignal) => Promise<void>;

const TIMED_OUT = Symbol("timed out");

export async function run(work: Work, budgetMs = BUDGET_MS): Promise<void> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(resolve, budgetMs, TIMED_OUT);
  });
  try {
    if ((await Promise.race([work(controller.signal), budget])) === TIMED_OUT) {
      controller.abort();
      warn("timed_out");
    }
  } catch {
    warn("internal_error");
  } finally {
    clearTimeout(timer);
  }
}
