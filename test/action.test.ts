import { mkdtempSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "vitest";
import type { Outcome } from "../src/warnings.ts";
import { fakeServer, PLACE, skip, type RunOptions, type Script } from "./helpers/server.ts";
import { makeTree } from "./helpers/tree.ts";

const DEBUG = { RUNNER_DEBUG: "1", ACTIONS_STEP_DEBUG: "true" };
const SKIP_CODES = [
  "not_onboarded",
  "cap_reached",
  "unsupported_event",
  "unsupported_project",
  "pipeline_public_publish",
  "pipeline_scanner",
  "pipeline_unreadable",
  "temporarily_unavailable",
] as const;
const PLACED = "AttackTrap: canary placed. Details are in your dashboard.";
const warning = (code: string) => new RegExp(`^::warning::AttackTrap \\[${code}\\]: .+ Your build is unaffected\\.$`);
const SERVER_TEXT = ["value-", "message-1", "content", "id-1", "example.com", PLACE.path];

async function fake(ctx: TestContext, script?: Script) {
  const server = await fakeServer(script);
  ctx.onTestFinished(() => server.close());
  return server;
}

type Case = { name: string; script?: Script; options?: () => RunOptions; outcome: Outcome; reported?: string };

const statuses = [201, 204, 400, 401, 404, 500, 503].map(
  (status): Case => ({ name: `canary ${status}`, script: { canary: { status, json: PLACE } }, outcome: "server_unreachable" }),
);
const redirects = [301, 302, 303, 307, 308].map(
  (status): Case => ({
    name: `canary redirect ${status}`,
    script: { canary: { status, headers: { location: "/v1/elsewhere" } } },
    outcome: "server_unreachable",
  }),
);

const CASES: Case[] = [
  { name: "no OIDC variables", options: () => ({ token: false }), outcome: "no_token" },
  { name: "token endpoint 500", script: { token: [{ status: 500 }] }, outcome: "no_token" },
  { name: "token endpoint 503, which the client retries", script: { token: [{ status: 503 }] }, outcome: "no_token" },
  { name: "token endpoint without value", script: { token: [{ status: 200, json: {} }] }, outcome: "no_token" },
  { name: "token endpoint hangs", script: { token: ["hang"] }, outcome: "no_token" },
  { name: "token endpoint drops", script: { token: ["drop"] }, outcome: "no_token" },
  { name: "no GITHUB_WORKSPACE", options: () => ({ workspace: null }), outcome: "no_checkout" },
  { name: "missing workspace", options: () => ({ workspace: path.join(tmpdir(), "missing-a") }), outcome: "no_checkout" },
  { name: "empty workspace", options: () => ({ workspace: mkdtempSync(path.join(tmpdir(), "empty-")) }), outcome: "no_checkout" },
  { name: "connection refused", options: () => ({ api: "http://127.0.0.1:1" }), outcome: "server_unreachable" },
  { name: "DNS failure", options: () => ({ api: "http://a.invalid" }), outcome: "server_unreachable" },
  { name: "canary hangs", script: { canary: "hang" }, outcome: "server_unreachable" },
  { name: "canary drops", script: { canary: "drop" }, outcome: "server_unreachable" },
  ...statuses,
  ...redirects,
  {
    name: "canary not JSON",
    script: { canary: { status: 200, text: "value-1", headers: { "content-type": "application/json" } } },
    outcome: "server_unreachable",
  },
  { name: "canary extra field", script: { canary: { status: 200, json: { ...PLACE, extra: "value-3" } } }, outcome: "server_unreachable" },
  { name: "canary unknown skip code", script: { canary: { status: 200, json: skip("value-4") } }, outcome: "server_unreachable" },
  ...SKIP_CODES.map((code): Case => ({ name: `skip ${code}`, script: { canary: { status: 200, json: skip(code) } }, outcome: code })),
  { name: "written", outcome: "written", reported: "written" },
  { name: "path exists", options: () => ({ files: { "a/b.txt": "existing" } }), outcome: "path_exists", reported: "path_exists" },
  { name: "parent missing", options: () => ({ files: { "x.txt": "content" } }), outcome: "write_failed", reported: "write_failed" },
  { name: "report 404", script: { report: { status: 404 } }, outcome: "written", reported: "written" },
  { name: "report 500", script: { report: { status: 500 } }, outcome: "written", reported: "written" },
  { name: "report hangs", script: { report: "hang" }, outcome: "written", reported: "written" },
  { name: "report drops", script: { report: "drop" }, outcome: "written", reported: "written" },
  { name: "fresh token for the report fails", script: { token: ["issue", { status: 500 }] }, outcome: "written" },
  {
    name: "report hangs past the run's budget",
    script: { report: "hang" },
    options: () => ({ callMs: 20_000, budgetMs: 5_000 }),
    outcome: "written",
    reported: "written",
  },
  {
    name: "canary hangs past the run's budget",
    script: { canary: "hang" },
    options: () => ({ callMs: 20_000, budgetMs: 5_000 }),
    outcome: "server_unreachable",
  },
];

describe("every outcome, with step debug logging on", () => {
  it.concurrent.for(CASES)("$name: exits 0 with only the $outcome line", async ({ script, options, outcome, reported }, ctx) => {
    const { expect } = ctx;
    const server = await fake(ctx, script);
    const run = await server.run({ ...options?.(), env: DEBUG });
    expect(run.code).toBe(0);
    expect(run.output).toEqual([outcome === "written" ? PLACED : expect.stringMatching(warning(outcome))]);
    expect(server.problems).toEqual([]);
    expect(server.seen.filter((s) => s.op === "other")).toEqual([]);
    expect(server.reports()).toEqual(reported ? [{ status: reported }] : []);
    for (const text of SERVER_TEXT) {
      expect(run.shown.join("\n")).not.toContain(text);
      expect(run.stderr).not.toContain(text);
    }
  });

  it.concurrent("sends nothing without a token", async (ctx) => {
    const server = await fake(ctx);
    await server.run({ token: false });
    ctx.expect(server.seen).toEqual([]);
  });

  it.concurrent("asks only for a token without a checkout", async (ctx) => {
    const server = await fake(ctx);
    await server.run({ workspace: null });
    ctx.expect(server.seen.map((s) => s.op)).toEqual(["token"]);
  });
});

describe("placeholder paths, through the supervisor", () => {
  it.concurrent("leaves an existing file alone", async (ctx) => {
    const { expect } = ctx;
    const server = await fake(ctx);
    const run = await server.run({ files: { "a/b.txt": "existing" } });
    expect(run.output).toEqual([expect.stringMatching(warning("path_exists"))]);
    expect(readFileSync(path.join(run.root!, "a", "b.txt"), "utf8")).toBe("existing");
    expect(server.reports()).toEqual([{ status: "path_exists" }]);
  });

  it.concurrent("refuses a path that escapes the workspace", async (ctx) => {
    const { expect } = ctx;
    const outside = makeTree({ "w/x.txt": "content" });
    const server = await fake(ctx, { canary: { status: 200, json: { ...PLACE, path: "../b.txt" } } });
    const run = await server.run({ workspace: path.join(outside, "w") });
    expect(run.output).toEqual([expect.stringMatching(warning("write_failed"))]);
    expect(readdirSync(outside)).toEqual(["w"]);
    expect(server.reports()).toEqual([{ status: "write_failed" }]);
  });

  it.concurrent("refuses a symlinked directory that leads outside", async (ctx) => {
    const { expect } = ctx;
    const outside = mkdtempSync(path.join(tmpdir(), "outside-"));
    const root = makeTree({ "x.txt": "content" });
    symlinkSync(outside, path.join(root, "a"), "junction");
    const server = await fake(ctx);
    const run = await server.run({ workspace: root });
    expect(run.output).toEqual([expect.stringMatching(warning("write_failed"))]);
    expect(readdirSync(outside)).toEqual([]);
    expect(server.reports()).toEqual([{ status: "write_failed" }]);
  });
});

describe("log", () => {
  it.concurrent("masks every value and the path before any other line", async (ctx) => {
    const { expect } = ctx;
    const server = await fake(ctx, { canary: { status: 200, json: { ...PLACE, mask: ["value-1", "", "value-2"] } } });
    const run = await server.run();
    const tokenUrl = `::debug::ID token url is ${server.oidcEnv.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=attacktrap`;
    expect(run.lines).toEqual([
      tokenUrl,
      "::add-mask::token-1",
      "::add-mask::value-1",
      "::add-mask::value-2",
      "::add-mask::a/b.txt",
      tokenUrl,
      "::add-mask::token-2",
      PLACED,
    ]);
    expect(readFileSync(path.join(run.root!, "a", "b.txt"), "utf8")).toBe("content");
    expect(run.stdout).not.toContain("content");
    expect(run.stdout).not.toContain("id-1");
  });

  it.concurrent("prints the same lines with step debug logging on", async (ctx) => {
    const quietServer = await fake(ctx);
    const loudServer = await fake(ctx);
    const [quiet, loud] = await Promise.all([quietServer.run(), loudServer.run({ env: DEBUG })]);
    const normalize = (lines: string[], origin: string) => lines.map((l) => l.replaceAll(origin, "<origin>"));
    ctx.expect(normalize(loud.lines, loudServer.origin)).toEqual(normalize(quiet.lines, quietServer.origin));
  });

  it.concurrent.for([
    ["the path exists", { files: { "a/b.txt": "existing" } }],
    ["the parent is missing", { files: { "x.txt": "content" } }],
  ] as const)("masks before the write when %s", async ([, options], ctx) => {
    const server = await fake(ctx);
    const run = await server.run(options);
    ctx.expect(run.lines.slice(1, 5)).toEqual(["::add-mask::token-1", "::add-mask::value-1", "::add-mask::value-2", "::add-mask::a/b.txt"]);
  });

  it.concurrent("never shows a skip's message or url, not even as a mask", async (ctx) => {
    const { expect } = ctx;
    const server = await fake(ctx, { canary: { status: 200, json: skip("not_onboarded") } });
    const run = await server.run({ env: DEBUG });
    expect(run.masks).toEqual(["token-1"]);
    expect(run.stdout).not.toContain("message-1");
    expect(run.stdout).not.toContain("example.com");
    expect(run.output).toEqual([expect.stringContaining("https://app.attacktrap.com/")]);
  });
});
