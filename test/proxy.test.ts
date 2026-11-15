import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportPlacement, requestCanary, type Server } from "../src/api.ts";
import { closedProxyUrl, fakeProxy, type FakeProxy, type ProxyMode } from "./helpers/proxy.ts";
import { fakeServer, PLACE, type Fake, type Script } from "./helpers/server.ts";

const PLACED = "AttackTrap: canary placed. Details are in your dashboard.";
const UNREACHABLE = /^::warning::AttackTrap \[server_unreachable\]: .+ Your build is unaffected\.$/;
const SERVER_TEXT = ["value-", "message-1", "content", "id-1", PLACE.path];
const PROXY_VARS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"];
const ABOUT = {
  pipeline: { findings: [], incomplete: false },
  project: { tree: [], dependencies: { node: [], python: [] }, manifests: {}, docker: {}, lambda: {}, build_targets: [] },
};
const CALL_MS = 1_000;
const never = new AbortController().signal;

let closers: (() => Promise<void>)[];
beforeEach(() => {
  closers = [];
  for (const name of PROXY_VARS) vi.stubEnv(name, "");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const close of closers) await close();
});

async function fake(script?: Script): Promise<Fake> {
  const server = await fakeServer(script);
  closers.push(() => server.close());
  for (const [k, v] of Object.entries(server.oidcEnv)) vi.stubEnv(k, v);
  return server;
}

async function proxy(mode: ProxyMode): Promise<FakeProxy> {
  const p = await fakeProxy(mode);
  closers.push(() => p.close());
  return p;
}

const env = (vars: Record<string, string>) => {
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
};
const at = (origin: string): Server => ({ origin, callMs: CALL_MS, deadline: never });

// a.invalid never resolves, so a call to it only arrives through the proxy.
const unresolvable = (origin: string) => `http://a.invalid:${new URL(origin).port}`;
const host = (origin: string) => `a.invalid:${new URL(origin).port}`;

describe("through a proxy", () => {
  it.for([
    ["HTTP_PROXY", (url: string) => ({ HTTP_PROXY: url })],
    ["http_proxy", (url: string) => ({ http_proxy: url })],
    ["NO_PROXY for other hosts", (url: string) => ({ HTTP_PROXY: url, NO_PROXY: "b.invalid,.example.com" })],
  ] as const)("sends both calls through the proxy with %s", async ([, vars]) => {
    const server = await fake();
    const p = await proxy({ tunnel: server.origin });
    env(vars(p.url));
    const api = at(unresolvable(server.origin));
    const place = await requestCanary(api, "token-1", ABOUT);
    expect(place).toEqual({ placementId: PLACE.placementId, path: PLACE.path, content: PLACE.content });
    await reportPlacement(api, place as typeof PLACE, "written");
    expect(server.seen.map((s) => s.op)).toEqual(["canary", "token", "report"]);
    expect(server.reports()).toEqual([{ status: "written" }]);
    expect(p.connects.length).toBeGreaterThan(0);
    expect(new Set(p.connects)).toEqual(new Set([host(server.origin)]));
    expect(p.requests).toEqual([]);
  });

  it.for(["HTTPS_PROXY", "https_proxy"])("asks %s to connect to an https origin", async (name) => {
    const p = await proxy("refuse");
    env({ [name]: p.url });
    expect(await requestCanary(at("https://a.invalid"), "token-1", ABOUT)).toBe("server_unreachable");
    expect(p.connects).toEqual(["a.invalid:443"]);
  });

  it("still refuses a redirect through the proxy", async () => {
    const server = await fake({ canary: { status: 302, headers: { location: "/v1/elsewhere" } } });
    const p = await proxy({ tunnel: server.origin });
    env({ HTTP_PROXY: p.url });
    expect(await requestCanary(at(unresolvable(server.origin)), "token-1", ABOUT)).toBe("server_unreachable");
    expect(server.seen.map((s) => s.op)).toEqual(["canary"]);
  });
});

describe("NO_PROXY", () => {
  it.for([
    ["http://a.invalid", "a.invalid"],
    ["http://a.invalid", "A.INVALID"],
    ["http://a.invalid", ".invalid"],
    ["http://a.invalid", "b.invalid, a.invalid"],
    ["http://a.invalid", "*"],
    ["https://a.invalid", "a.invalid:443"],
    ["https://b.a.invalid", "a.invalid"],
  ])("skips the proxy for %s with NO_PROXY=%s", async ([origin, noProxy]) => {
    const p = await proxy("refuse");
    env({ HTTP_PROXY: p.url, HTTPS_PROXY: p.url, NO_PROXY: noProxy });
    expect(await requestCanary(at(origin), "token-1", ABOUT)).toBe("server_unreachable");
    expect(p.connects).toEqual([]);
    expect(p.requests).toEqual([]);
  });

  it("reaches a NO_PROXY host directly", async () => {
    const server = await fake();
    const p = await proxy("refuse");
    env({ HTTP_PROXY: p.url, NO_PROXY: "127.0.0.1" });
    expect(await requestCanary(at(server.origin), "token-1", ABOUT)).toMatchObject({ placementId: PLACE.placementId });
    expect(p.connects).toEqual([]);
  });
});

describe("a broken proxy", () => {
  it.for([
    ["refusing", async (): Promise<string> => (await proxy("refuse")).url],
    ["hanging", async (): Promise<string> => (await proxy("hang")).url],
    ["not a URL", async (): Promise<string> => "http://[value-1"],
  ] as const)("%s: the call is server_unreachable within callMs", async ([, url]) => {
    const proxyUrl = await url();
    env({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl });
    const start = performance.now();
    expect(await requestCanary(at("http://a.invalid"), "token-1", ABOUT)).toBe("server_unreachable");
    await reportPlacement(at("http://a.invalid"), PLACE, "written");
    expect(performance.now() - start).toBeLessThan(3 * CALL_MS);
  });
});

// Whole runs through the supervisor. Few of them, because each starts processes that slow the timing tests in other files.
describe("a run behind a proxy", () => {
  const BUDGET_MS = 5_000;

  it("places through the proxy and masks before printing", async () => {
    const server = await fakeServer();
    closers.push(() => server.close());
    const p = await proxy({ tunnel: server.origin });
    const run = await server.run({ api: unresolvable(server.origin), env: { HTTPS_PROXY: p.url, HTTP_PROXY: p.url } });
    expect(run.code).toBe(0);
    expect(run.output).toEqual([PLACED]);
    expect(server.seen.map((s) => s.op)).toEqual(["token", "canary", "token", "report"]);
    expect(server.problems).toEqual([]);
    expect(new Set(p.connects)).toEqual(new Set([host(server.origin)]));
    expect(run.lines.indexOf("::add-mask::a/b.txt")).toBeLessThan(run.lines.indexOf(PLACED));
    for (const text of SERVER_TEXT) {
      expect(run.shown.join("\n")).not.toContain(text);
      expect(run.stderr).not.toContain(text);
    }
  });

  it.for([
    ["unreachable, with a user in the URL", async (): Promise<string> => (await closedProxyUrl()).replace("//", "//user-1:value-1@")],
    ["hanging", async (): Promise<string> => (await proxy("hang")).url],
  ] as const)("%s proxy: exits 0 with only the server_unreachable line", async ([, url]) => {
    const server = await fakeServer();
    closers.push(() => server.close());
    const proxyUrl = await url();
    const run = await server.run({
      api: "https://a.invalid",
      env: { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl },
      callMs: CALL_MS,
      budgetMs: BUDGET_MS,
    });
    expect(run.code).toBe(0);
    expect(run.output).toEqual([expect.stringMatching(UNREACHABLE)]);
    expect(server.seen.map((s) => s.op)).toEqual(["token"]);
    expect(run.ms).toBeLessThan(BUDGET_MS);
    expect(run.stdout).not.toContain("value-1");
  });
});
