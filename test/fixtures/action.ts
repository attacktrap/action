import { action } from "../../src/action.ts";
import { serverAt } from "../../src/api.ts";
import { main } from "../../src/main.ts";

// The real supervisor and flow, aimed at a local fake. The supervisor re-spawns this file with the
// same arguments plus --work, so the worker reads them too.
const [origin, callMs, budgetMs] = process.argv.slice(2);
const budget = Number(budgetMs);
await main(() => action(serverAt(origin, { callMs: Number(callMs), budgetMs: budget })), { budgetMs: budget });
