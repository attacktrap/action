import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { say, SKIPS, type Outcome } from "../src/warnings.ts";

const spec = parse(readFileSync(new URL("../openapi/action-v1.yaml", import.meta.url), "utf8"));

const OUTCOMES = Object.keys({
  written: 0,
  no_token: 0,
  no_checkout: 0,
  server_unreachable: 0,
  path_exists: 0,
  write_failed: 0,
  not_onboarded: 0,
  cap_reached: 0,
  unsupported_event: 0,
  unsupported_project: 0,
  pipeline_public_publish: 0,
  pipeline_scanner: 0,
  pipeline_unreadable: 0,
  temporarily_unavailable: 0,
} satisfies Record<Outcome, 0>) as Outcome[];

const PLACED = "AttackTrap: canary placed. Details are in your dashboard.";
const warning = (code: string) => new RegExp(`^::warning::AttackTrap \\[${code}\\]: [^\\r\\n]+ Your build is unaffected\\.$`);

function printed(outcome: Outcome): string[] {
  const writes: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (writes.push(String(chunk)), true));
  say(outcome);
  vi.restoreAllMocks();
  return writes.join("").split(/\r?\n/).filter((line) => line !== "");
}

afterEach(() => vi.restoreAllMocks());

describe("skip codes", () => {
  it("are the spec's SkipCode enum, no more and no fewer", () => {
    expect(Object.keys(SKIPS).sort()).toEqual([...spec.components.schemas.SkipCode.enum].sort());
  });
});

describe("say", () => {
  it.each(OUTCOMES)("prints one fixed line for %s", (outcome) => {
    expect(printed(outcome)).toEqual([outcome === "written" ? PLACED : expect.stringMatching(warning(outcome))]);
  });

  it("links only to the sign-up page, and only for not_onboarded", () => {
    const links = OUTCOMES.map((outcome) => [outcome, printed(outcome).join("").match(/https?:\/\/[^\s]*[^\s.]/g) ?? []]);
    expect(links.filter(([, urls]) => urls.length > 0)).toEqual([["not_onboarded", ["https://app.attacktrap.com/"]]]);
  });
});
