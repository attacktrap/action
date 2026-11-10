import { main } from "../../src/main.ts";
import { faults, type FaultName } from "../helpers/faults.ts";

const [name, budget] = process.argv.slice(2);
const work = name === "none" ? async () => {} : faults[name as FaultName];
await main(work, { budgetMs: budget === undefined ? undefined : Number(budget) });
