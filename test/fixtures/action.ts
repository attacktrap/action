import { action } from "../../src/action.ts";
import { serverAt } from "../../src/api.ts";
import { main } from "../../src/main.ts";

const [origin, callMs, budgetMs] = process.argv.slice(2);
const budget = Number(budgetMs);
await main(() => action(serverAt(origin, { callMs: Number(callMs), budgetMs: budget })), { budgetMs: budget });
