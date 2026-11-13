import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getToken, reportPlacement, requestCanary, type Server } from "../src/api.ts";
import { SKIPS } from "../src/warnings.ts";
import { fakeServer, PLACE, skip, type Answer, type Fake, type Script } from "./helpers/server.ts";
import { specValidator } from "./helpers/spec.ts";

const validPlace = specValidator("Place", { formats: false });
const validSkip = specValidator("Skip", { formats: false });
const specAccepts = (body: unknown) => validPlace(body) || validSkip(body);

const ABOUT = {
  pipeline: { findings: [], incomplete: false },
  project: { tree: [], dependencies: { node: [], python: [] }, manifests: {}, docker: {}, lambda: {}, build_targets: [] },
};
const never = new AbortController().signal;

let fake: Fake;
let server: Server;
let stdout: string[];
beforeEach(async () => {
  fake = await fakeServer();
  server = { origin: fake.origin, callMs: 500, deadline: never };
  for (const [k, v] of Object.entries(fake.oidcEnv)) vi.stubEnv(k, v);
  stdout = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (stdout.push(String(chunk)), true));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fake.close();
});
const masks = () => stdout.filter((l) => l.startsWith("::add-mask::")).map((l) => l.trimEnd().slice("::add-mask::".length));
const shown = () => stdout.filter((l) => !l.startsWith("::add-mask::") && !l.startsWith("::debug::"));

const without = (o: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
const URLS = [
  "",
  "a",
  "/a/b",
  "https://example.com/",
  "https://example.com/a?b=c#d",
  "https://example.com/a b",
  " https://example.com/",
  "mailto:a@example.com",
  "urn:a:b",
  "https://例え.jp/",
  "http://[::1]/",
  "https://example.com/%41",
  "https://example.com/%zz",
  "https://example.com/a<b",
  "https://example.com/{a}",
  "https://example.com/a|b",
  "https://example.com/a\\b",
  "https://example.com/a^b",
  "https://example.com/`a`",
  'https://example.com/"a"',
  "https://example.com/[a]",
  "https://example.com/a#b#c",
  "a:[",
  "http:///",
  "http://:4",
  "file:///",
];
const BODIES: [string, unknown][] = [
  ["place", PLACE],
  ["place, empty mask", { ...PLACE, mask: [] }],
  ["place, empty content", { ...PLACE, content: "" }],
  ["place, empty mask value", { ...PLACE, mask: [""] }],
  ...["result", "placementId", "path", "content", "mask"].map((k): [string, unknown] => [`place without ${k}`, without(PLACE, k)]),
  ["place, extra field", { ...PLACE, extra: "value-1" }],
  ["place, skip's field", { ...PLACE, code: "not_onboarded" }],
  ["place, empty placementId", { ...PLACE, placementId: "" }],
  ["place, empty path", { ...PLACE, path: "" }],
  ["place, numeric placementId", { ...PLACE, placementId: 1 }],
  ["place, null path", { ...PLACE, path: null }],
  ["place, numeric content", { ...PLACE, content: 1 }],
  ["place, mask a string", { ...PLACE, mask: "value-1" }],
  ["place, mask of numbers", { ...PLACE, mask: [1] }],
  ["place, mask of null", { ...PLACE, mask: [null] }],
  ...Object.keys(SKIPS).map((code): [string, unknown] => [`skip ${code}`, skip(code)]),
  ["skip without url", without(skip("cap_reached"), "url")],
  ...["result", "code", "message"].map((k): [string, unknown] => [`skip without ${k}`, without(skip("cap_reached"), k)]),
  ["skip, extra field", { ...skip("cap_reached"), extra: "value-1" }],
  ["skip, place's field", { ...skip("cap_reached"), path: "a/b.txt" }],
  ["skip, unknown code", skip("value-1")],
  ["skip, prototype key as code", skip("toString")],
  ["skip, numeric message", { ...skip("cap_reached"), message: 1 }],
  ...URLS.map((url): [string, unknown] => [`skip, url ${JSON.stringify(url)}`, { ...skip("cap_reached"), url }]),
  ["skip, null url", { ...skip("cap_reached"), url: null }],
  ["unknown result", { ...PLACE, result: "value-1" }],
  ["null", null],
  ["array", [PLACE]],
  ["string", "place"],
  ["number", 1],
];

describe("requestCanary parse", () => {
  it.each(BODIES)("agrees with the spec, with format as an annotation, on %s", async (_, body) => {
    fake.script.canary = { status: 200, json: body };
    const got = await requestCanary(server, "token-1", ABOUT);
    expect(got !== "server_unreachable").toBe(specAccepts(body));
  });

  it("refuses an own __proto__ key", async () => {
    const text = `{"__proto__":{},${JSON.stringify(PLACE).slice(1)}`;
    fake.script.canary = { status: 200, text, headers: { "content-type": "application/json" } };
    expect(await requestCanary(server, "token-1", ABOUT)).toBe("server_unreachable");
  });

  it("masks the path and every non-empty mask value, then returns the place without its mask list", async () => {
    fake.script.canary = { status: 200, json: { ...PLACE, mask: ["value-1", "", "value-2"] } };
    expect(await requestCanary(server, "token-1", ABOUT)).toEqual({ placementId: "id-1", path: "a/b.txt", content: "content" });
    expect(masks()).toEqual(["value-1", "value-2", "a/b.txt"]);
    expect(shown()).toEqual([]);
  });

  it("returns a skip as its code alone and prints nothing", async () => {
    fake.script.canary = { status: 200, json: skip("cap_reached") };
    expect(await requestCanary(server, "token-1", ABOUT)).toBe("cap_reached");
    expect(stdout).toEqual([]);
  });

  it("masks nothing from a refused reply", async () => {
    fake.script.canary = { status: 200, json: { ...PLACE, extra: "value-3" } };
    expect(await requestCanary(server, "token-1", ABOUT)).toBe("server_unreachable");
    expect(stdout).toEqual([]);
  });

  it.each<[string, Answer, boolean]>([
    ["text/plain", { status: 200, text: JSON.stringify(PLACE), headers: { "content-type": "text/plain" } }, false],
    ["no content type", { status: 200, text: JSON.stringify(PLACE) }, false],
    ["JSON with a charset", { status: 200, text: JSON.stringify(PLACE), headers: { "content-type": "application/json; charset=utf-8" } }, true],
  ])("checks the media type: %s", async (_, answer, accepted) => {
    fake.script.canary = answer;
    expect((await requestCanary(server, "token-1", ABOUT)) !== "server_unreachable").toBe(accepted);
  });

  it.each([201, 204, 400, 401, 404, 500, 503])("refuses a %i", async (status) => {
    fake.script.canary = { status, json: PLACE };
    expect(await requestCanary(server, "token-1", ABOUT)).toBe("server_unreachable");
  });
});

describe("requestCanary transport", () => {
  it("sends a spec-valid request with the token", async () => {
    const token = await getToken(server);
    await requestCanary(server, token!, ABOUT);
    expect(fake.problems).toEqual([]);
    expect(fake.seen.map((s) => [s.op, s.auth])).toEqual([
      ["token", `Bearer ${fake.oidcEnv.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`],
      ["canary", "Bearer token-1"],
    ]);
    expect(fake.seen[1].body).toEqual({ action_version: "1.0.0", ...ABOUT });
  });

  it.each([301, 302, 303, 307, 308])("refuses a %i redirect without following it", async (status) => {
    fake.script.canary = { status, headers: { location: "/v1/elsewhere" } };
    expect(await requestCanary(server, "token-1", ABOUT)).toBe("server_unreachable");
    expect(fake.seen.map((s) => s.op)).toEqual(["canary"]);
  });

  it("stops at callMs", async () => {
    fake.script.canary = "hang";
    const start = performance.now();
    expect(await requestCanary(server, "token-1", ABOUT)).toBe("server_unreachable");
    expect(performance.now() - start).toBeLessThan(server.callMs + 500);
  });

  it("stops at once when the deadline has passed", async () => {
    const got = await requestCanary({ ...server, callMs: 20_000, deadline: AbortSignal.abort() }, "token-1", ABOUT);
    expect(got).toBe("server_unreachable");
    expect(fake.seen).toEqual([]);
  });
});

describe("getToken", () => {
  it("asks for the attacktrap audience", async () => {
    expect(await getToken(server)).toBe("token-1");
    expect(fake.problems).toEqual([]);
  });

  it.each<[string, () => void]>([
    ["no OIDC variables", () => Object.keys(fake.oidcEnv).forEach((k) => vi.stubEnv(k, ""))],
    ["a 503, despite the client's retries", () => (fake.script.token = [{ status: 503 }])],
    ["no value", () => (fake.script.token = [{ status: 200, json: {} }])],
    ["a hang", () => (fake.script.token = ["hang"])],
    ["a dropped connection", () => (fake.script.token = ["drop"])],
  ])("is undefined on %s, within callMs", async (_, arrange) => {
    arrange();
    const start = performance.now();
    expect(await getToken(server)).toBeUndefined();
    expect(performance.now() - start).toBeLessThan(server.callMs + 500);
  });
});

describe("reportPlacement", () => {
  const place = { placementId: "id-1", path: "a/b.txt", content: "content" };

  it("sends the status with a token issued after the canary request", async () => {
    await requestCanary(server, (await getToken(server))!, ABOUT);
    await reportPlacement(server, place, "path_exists");
    expect(fake.problems).toEqual([]);
    expect(fake.seen.map((s) => s.op)).toEqual(["token", "canary", "token", "report"]);
    expect(fake.reports()).toEqual([{ status: "path_exists" }]);
  });

  it.each<[string, Script]>([
    ["404", { report: { status: 404 } }],
    ["500", { report: { status: 500 } }],
    ["a hang", { report: "hang" }],
    ["a dropped connection", { report: "drop" }],
    ["a failed fresh token", { token: [{ status: 500 }] }],
  ])("settles quietly on %s", async (_, script) => {
    Object.assign(fake.script, script);
    const start = performance.now();
    await expect(reportPlacement(server, place, "written")).resolves.toBeUndefined();
    expect(performance.now() - start).toBeLessThan(2 * server.callMs + 500);
    expect(shown()).toEqual([]);
  });
});
