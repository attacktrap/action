import { describe, expect, it } from "vitest";
import type { WarningCode } from "../src/warnings.ts";
import { faults, runEntry, runNode, type FaultName } from "./helpers/faults.ts";

const BUDGET_MS = 1_000;

const expected: Record<FaultName, WarningCode> = {
  throws: "internal_error",
  rejects: "internal_error",
  hangs: "timed_out",
  spins: "timed_out",
  throwsLater: "internal_error",
  rejectsUnhandled: "internal_error",
  exits: "internal_error",
  breaksStdout: "internal_error",
};

describe("entry", () => {
  it.each(Object.keys(faults) as FaultName[])("%s exits 0 with only its fixed warning", async (fault) => {
    const result = await runEntry(fault, { budgetMs: BUDGET_MS });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`::warning::Woozle Trap [${expected[fault]}]: `);
    expect(result.stdout.match(/::warning::/g)).toHaveLength(1);
    expect(result.stdout).not.toContain("fault content");
    expect(result.stderr).not.toContain("fault content");
    expect(result.ms).toBeLessThan(BUDGET_MS);
  });

  it("exits 0 without a warning when the work succeeds", async () => {
    const result = await runEntry("none", { budgetMs: BUDGET_MS });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("::warning::");
    expect(result.ms).toBeLessThan(BUDGET_MS);
  });

  it("built dist/index.js exits 0 without a warning and no env", async () => {
    const result = await runNode(["dist/index.js"], {});
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("::warning::");
  });
});
