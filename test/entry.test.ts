import { describe, expect, it } from "vitest";
import type { WarningCode } from "../src/warnings.ts";
import { faults, runEntry, runNode, type FaultName } from "./helpers/faults.ts";

const expected: Record<FaultName, WarningCode> = {
  throws: "internal_error",
  rejects: "internal_error",
  hangs: "timed_out",
  throwsLater: "internal_error",
  rejectsUnhandled: "internal_error",
};

describe("entry", () => {
  it.each(Object.keys(faults) as FaultName[])("%s exits 0 with its warning", async (fault) => {
    const result = await runEntry(fault, { budgetMs: 500 });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`::warning::Woozle Trap [${expected[fault]}]: `);
  });

  it("stops hanging work at the budget", async () => {
    const result = await runEntry("hangs", { budgetMs: 500 });
    expect(result.ms).toBeGreaterThanOrEqual(500);
    expect(result.ms).toBeLessThan(3_000);
  });

  it("exits 0 without a warning when the work succeeds", async () => {
    const result = await runEntry("none");
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("::warning::");
  });

  it("built dist/index.js exits 0 without a warning and no env", async () => {
    const result = await runNode(["dist/index.js"], {});
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("::warning::");
  });
});
