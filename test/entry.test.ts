import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { WarningCode } from "../src/warnings.ts";
import { faults, runEntry, runNode, type FaultName } from "./helpers/faults.ts";
import { fakeServer, isolatedEnv, readLog } from "./helpers/server.ts";

const BUDGET_MS = 2_000;

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
    expect(result.stdout).toContain(`::warning::AttackTrap [${expected[fault]}]: `);
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

  it("built dist/index.js with no env exits 0 with only the no_token line", async () => {
    const result = await runNode(["dist/index.js"], isolatedEnv({}));
    expect(result.code).toBe(0);
    expect(readLog(result.stdout).lines).toEqual([expect.stringMatching(/^::warning::AttackTrap \[no_token\]: /)]);
  });

  // dist/ always talks to the production origin, so these stop before the API.
  it("built dist/index.js with a token and no workspace asks only for the token", async () => {
    const fake = await fakeServer();
    try {
      const result = await runNode(["dist/index.js"], isolatedEnv(fake.oidcEnv));
      expect(result.code).toBe(0);
      expect(readLog(result.stdout).output).toEqual([expect.stringMatching(/^::warning::AttackTrap \[no_checkout\]: /)]);
      expect(fake.seen.map((s) => s.op)).toEqual(["token"]);
      expect(fake.problems).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it("built dist/index.js holds the production API origin and no other", () => {
    const bundle = readFileSync("dist/index.js", "utf8");
    expect(bundle).toContain('"https://app.attacktrap.com"');
    expect(bundle).not.toContain("example.invalid");
  });
});
