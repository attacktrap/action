import { describe, it, type TestContext } from "vitest";
import { closedProxyUrl, fakeProxy, type ProxyMode } from "./helpers/proxy.ts";
import { fakeServer, PLACE, type Script } from "./helpers/server.ts";

const PLACED = "AttackTrap: canary placed. Details are in your dashboard.";
const warning = (code: string) => new RegExp(`^::warning::AttackTrap \\[${code}\\]: .+ Your build is unaffected\\.$`);
const SERVER_TEXT = ["value-", "message-1", "content", "id-1", PLACE.path];

async function fake(ctx: TestContext, script?: Script) {
  const server = await fakeServer(script);
  ctx.onTestFinished(() => server.close());
  return server;
}

async function proxy(ctx: TestContext, mode: ProxyMode) {
  const p = await fakeProxy(mode);
  ctx.onTestFinished(() => p.close());
  return p;
}

// a.invalid never resolves, so a call to it only arrives through the proxy.
const unresolvable = (origin: string) => `http://a.invalid:${new URL(origin).port}`;
const host = (origin: string) => `a.invalid:${new URL(origin).port}`;

describe("through a proxy", () => {
  it.concurrent.for([
    ["HTTP_PROXY", (url: string) => ({ HTTP_PROXY: url })],
    ["http_proxy", (url: string) => ({ http_proxy: url })],
    ["NO_PROXY for another host", (url: string) => ({ HTTP_PROXY: url, NO_PROXY: "b.invalid,.example.com" })],
  ] as const)("sends both calls through the proxy with %s", async ([, env], ctx) => {
    const { expect } = ctx;
    const server = await fake(ctx);
    const p = await proxy(ctx, { tunnel: server.origin });
    const run = await server.run({ api: unresolvable(server.origin), env: env(p.url) });
    expect(run.code).toBe(0);
    expect(run.output).toEqual([PLACED]);
    expect(server.seen.map((s) => s.op)).toEqual(["token", "canary", "token", "report"]);
    expect(server.reports()).toEqual([{ status: "written" }]);
    expect(server.problems).toEqual([]);
    expect(p.connects.length).toBeGreaterThan(0);
    expect(new Set(p.connects)).toEqual(new Set([host(server.origin)]));
    expect(p.requests).toEqual([]);
    expect(run.lines.indexOf("::add-mask::a/b.txt")).toBeLessThan(run.lines.indexOf(PLACED));
    for (const text of SERVER_TEXT) {
      expect(run.shown.join("\n")).not.toContain(text);
      expect(run.stderr).not.toContain(text);
    }
  });

  it.concurrent.for(["HTTPS_PROXY", "https_proxy"])("asks %s to connect to an https origin", async (name, ctx) => {
    const { expect } = ctx;
    const server = await fake(ctx);
    const p = await proxy(ctx, "refuse");
    const run = await server.run({ api: "https://a.invalid", env: { [name]: p.url } });
    expect(run.code).toBe(0);
    expect(run.output).toEqual([expect.stringMatching(warning("server_unreachable"))]);
    expect(p.connects).toEqual(["a.invalid:443"]);
  });

  it.concurrent("still refuses a redirect through the proxy", async (ctx) => {
    const { expect } = ctx;
    const server = await fake(ctx, { canary: { status: 302, headers: { location: "/v1/elsewhere" } } });
    const p = await proxy(ctx, { tunnel: server.origin });
    const run = await server.run({ api: unresolvable(server.origin), env: { HTTP_PROXY: p.url } });
    expect(run.output).toEqual([expect.stringMatching(warning("server_unreachable"))]);
    expect(server.seen.map((s) => s.op)).toEqual(["token", "canary"]);
  });
});

describe("NO_PROXY", () => {
  it.concurrent.for([
    ["http://a.invalid", "a.invalid"],
    ["http://a.invalid", "A.INVALID"],
    ["http://a.invalid", ".invalid"],
    ["http://a.invalid", "b.invalid, a.invalid"],
    ["http://a.invalid", "*"],
    ["https://a.invalid", "a.invalid:443"],
    ["https://b.a.invalid", "a.invalid"],
  ])("skips the proxy for %s with NO_PROXY=%s", async ([api, noProxy], ctx) => {
    const { expect } = ctx;
    const server = await fake(ctx);
    const p = await proxy(ctx, { tunnel: server.origin });
    const run = await server.run({ api, env: { HTTP_PROXY: p.url, HTTPS_PROXY: p.url, NO_PROXY: noProxy } });
    expect(run.code).toBe(0);
    expect(run.output).toEqual([expect.stringMatching(warning("server_unreachable"))]);
    expect(p.connects).toEqual([]);
    expect(p.requests).toEqual([]);
  });

  it.concurrent("reaches the server directly for a NO_PROXY host", async (ctx) => {
    const { expect } = ctx;
    const server = await fake(ctx);
    const p = await proxy(ctx, "refuse");
    const run = await server.run({ env: { HTTP_PROXY: p.url, NO_PROXY: "127.0.0.1" } });
    expect(run.output).toEqual([PLACED]);
    expect(server.reports()).toEqual([{ status: "written" }]);
    expect(p.connects).toEqual([]);
  });
});

describe("a broken proxy", () => {
  const CALL_MS = 1_000;
  const BUDGET_MS = 5_000;

  it.concurrent.for([
    ["unreachable, with a user in the URL", async () => (await closedProxyUrl()).replace("//", "//user-1:value-1@")],
    ["refusing", async (ctx: TestContext) => (await proxy(ctx, "refuse")).url],
    ["hanging", async (ctx: TestContext) => (await proxy(ctx, "hang")).url],
    ["not a URL", async () => "http://[value-1"],
  ] as const)("%s: exits 0 with only the server_unreachable line", async ([, url], ctx) => {
    const { expect } = ctx;
    const server = await fake(ctx);
    const proxyUrl = await url(ctx);
    const env = { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl };
    const run = await server.run({ api: unresolvable(server.origin), env, callMs: CALL_MS, budgetMs: BUDGET_MS });
    expect(run.code).toBe(0);
    expect(run.output).toEqual([expect.stringMatching(warning("server_unreachable"))]);
    expect(server.seen.map((s) => s.op)).toEqual(["token"]);
    expect(run.ms).toBeLessThan(BUDGET_MS);
    expect(run.stdout).not.toContain(proxyUrl);
  });

  it.concurrent("keeps a report that hangs behind the proxy silent", async (ctx) => {
    const { expect } = ctx;
    const server = await fake(ctx, { report: "hang" });
    const p = await proxy(ctx, { tunnel: server.origin });
    const run = await server.run({ api: unresolvable(server.origin), env: { HTTP_PROXY: p.url }, callMs: CALL_MS, budgetMs: BUDGET_MS });
    expect(run.code).toBe(0);
    expect(run.output).toEqual([PLACED]);
    expect(run.ms).toBeLessThan(BUDGET_MS);
  });
});
