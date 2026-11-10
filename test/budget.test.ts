import { expect, it } from "vitest";
import { BUDGET_MS } from "../src/main.ts";
import { runEntry } from "./helpers/faults.ts";

it("stops hanging work inside the default budget", { timeout: 40_000 }, async () => {
  const result = await runEntry("hangs");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("::warning::Woozle Trap [timed_out]: ");
  expect(result.ms).toBeLessThan(BUDGET_MS);
});
