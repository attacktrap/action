import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

describe("printing", () => {
  const QUIET_CORE = new Set(["getIDToken", "setSecret"]);
  const PRINTS = [
    /\bconsole\.\w+/g,
    /\bprocess\.std(?:out|err)\b/g,
    /\bimport\s+(?!\*\s+as\s+core\s)[^;]*?from\s+["']@actions\/core["']/g,
    /\bimport\s*\(\s*["']@actions\/core["']/g,
  ];
  const prints = (text: string) => [
    ...[...text.matchAll(/\bcore\.(\w+)/g)].filter((m) => !QUIET_CORE.has(m[1])).map((m) => m[0]),
    ...PRINTS.flatMap((pattern) => [...text.matchAll(pattern)].map((m) => m[0])),
  ];

  it("happens only in warnings.ts", () => {
    const src = fileURLToPath(new URL("../src/", import.meta.url));
    const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts") && f !== "warnings.ts");
    const found = files.map((f) => [f, prints(readFileSync(path.join(src, f), "utf8"))] as const).filter(([, uses]) => uses.length > 0);
    expect(found).toEqual([]);
  });
});
