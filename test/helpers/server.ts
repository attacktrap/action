import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { runNode, type EntryResult } from "./faults.ts";
import { specValidator } from "./spec.ts";
import { makeTree } from "./tree.ts";

// A local stand-in for the OIDC token endpoint and both API operations. It checks every request
// against the spec and the token rules, and records each violation in `problems`.

export const REQUEST_TOKEN = "request-token";

export type Answer =
  | { status: number; json?: unknown; text?: string; headers?: Record<string, string> }
  | "hang" // read the request and never answer
  | "drop"; // destroy the socket

export type Script = {
  /** Answers token requests in order, repeating the last. "issue" sends a new `token-<n>`. Default ["issue"]. */
  token?: (Answer | "issue")[];
  /** Default 200 PLACE. */
  canary?: Answer;
  /** Default 204. */
  report?: Answer;
};

export const PLACE = { result: "place", placementId: "id-1", path: "a/b.txt", content: "content", mask: ["value-1", "value-2"] };
export const skip = (code: string) => ({ result: "skip", code, message: "message-1", url: "https://example.com/value-1" });

export type Seen = { op: "token" | "canary" | "report" | "other"; method: string; url: string; auth: string | undefined; body: unknown };

export type RunOptions = {
  /** Workspace files. Default { "a/x.txt": "content" }, so `a/` exists for PLACE.path. */
  files?: Record<string, string>;
  /** A prepared directory to use as GITHUB_WORKSPACE instead of `files`; null leaves it unset. */
  workspace?: string | null;
  /** false: no OIDC variables at all. */
  token?: boolean;
  /** The API origin. Default this fake. */
  api?: string;
  env?: NodeJS.ProcessEnv;
  /** Default 1_000. */
  callMs?: number;
  /** Default 10_000. */
  budgetMs?: number;
};

export type Log = {
  lines: string[];
  /** Values registered with `::add-mask::`, unescaped. The runner consumes these lines. */
  masks: string[];
  /** Every other line, debug lines included: what the job log can show. */
  shown: string[];
  /** `shown` without `::debug::` lines: the Action's own output. */
  output: string[];
};

export type Run = EntryResult & Log & { root: string | undefined };

export type Fake = {
  readonly origin: string;
  /** Can be changed between requests. */
  readonly script: Script;
  readonly seen: Seen[];
  readonly problems: string[];
  readonly oidcEnv: { ACTIONS_ID_TOKEN_REQUEST_URL: string; ACTIONS_ID_TOKEN_REQUEST_TOKEN: string };
  reports(): unknown[];
  /** Runs the Action through the real supervisor, aimed at this fake. */
  run(options?: RunOptions): Promise<Run>;
  close(): Promise<void>;
};

const FIXTURE = fileURLToPath(new URL("../fixtures/action.ts", import.meta.url));

const validRequest = specValidator("CanaryRequest");
const validResult = specValidator("PlacementResult");
const REPORT = /^\/v1\/placements\/([^/]+)\/result$/;

export async function fakeServer(script: Script = {}): Promise<Fake> {
  const seen: Seen[] = [];
  const problems: string[] = [];
  const issued: string[] = [];
  let issuedAtCanary = 0;
  const offered = new Set<string>();

  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const auth = req.headers.authorization;
    const body = await readJson(req);
    const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
    const see = (op: Seen["op"]) => seen.push({ op, method: req.method ?? "", url: req.url ?? "", auth, body });

    if (url.pathname === "/token") {
      see("token");
      if (auth !== `Bearer ${REQUEST_TOKEN}`) problems.push("token request without the request token");
      if (url.searchParams.get("audience") !== "attacktrap") problems.push("token request for another audience");
      const answers = script.token ?? ["issue"];
      const answer = answers[Math.min(seen.filter((s) => s.op === "token").length, answers.length) - 1];
      if (answer !== "issue") return respond(res, answer);
      issued.push(`token-${issued.length + 1}`);
      return respond(res, { status: 200, json: { value: issued.at(-1) } });
    }

    if (url.pathname === "/v1/canaries") {
      see("canary");
      issuedAtCanary = issued.length;
      if (req.method !== "POST") problems.push("canary request is not a POST");
      if (bearer === undefined || !issued.includes(bearer)) problems.push("canary request without an issued token");
      if (!req.headers["content-type"]?.startsWith("application/json")) problems.push("canary request is not JSON");
      if (!validRequest(body)) problems.push(`canary request body: ${JSON.stringify(validRequest.errors)}`);
      const answer = script.canary ?? { status: 200, json: PLACE };
      const id = typeof answer === "object" ? (answer.json as { placementId?: unknown } | undefined)?.placementId : undefined;
      if (typeof id === "string") offered.add(id);
      return respond(res, answer);
    }

    const report = REPORT.exec(url.pathname);
    if (report) {
      see("report");
      const at = bearer === undefined ? -1 : issued.indexOf(bearer);
      if (req.method !== "POST") problems.push("report is not a POST");
      if (at === -1 || at < issuedAtCanary) problems.push("report without a token issued after the canary request");
      if (!offered.has(decodeURIComponent(report[1]))) problems.push("report for a placement this fake did not offer");
      if (!validResult(body)) problems.push(`report body: ${JSON.stringify(validResult.errors)}`);
      return respond(res, script.report ?? { status: 204 });
    }

    see("other");
    problems.push(`unexpected request ${req.method} ${url.pathname}`);
    respond(res, { status: 404 });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  const oidcEnv = { ACTIONS_ID_TOKEN_REQUEST_URL: `${origin}/token?api-version=2.0`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN };

  return {
    origin,
    script,
    seen,
    problems,
    oidcEnv,
    reports: () => seen.filter((s) => s.op === "report").map((s) => s.body),
    run: (options = {}) => runAction(origin, oidcEnv, options),
    close: async () => {
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

async function runAction(origin: string, oidcEnv: Fake["oidcEnv"], options: RunOptions): Promise<Run> {
  const root = options.workspace === undefined ? makeTree(options.files ?? { "a/x.txt": "content" }) : (options.workspace ?? undefined);
  const env = isolatedEnv({
    ...(options.token === false ? {} : oidcEnv),
    ...(root ? { GITHUB_WORKSPACE: root } : {}),
    GITHUB_REPOSITORY: "o/r",
    ...options.env,
  });
  const args = [FIXTURE, options.api ?? origin, String(options.callMs ?? 1_000), String(options.budgetMs ?? 10_000)];
  const result = await runNode(args, env);
  return { ...result, ...readLog(result.stdout), root };
}

/** `vars` and nothing else from this process, so a real OIDC endpoint in CI's env can't leak in. */
export function isolatedEnv(vars: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Windows needs SystemRoot to open sockets.
  return { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...vars };
}

const MASK = "::add-mask::";

export function readLog(stdout: string): Log {
  const lines = stdout.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const masks = lines.filter((l) => l.startsWith(MASK)).map((l) => unescapeData(l.slice(MASK.length)));
  const shown = lines.filter((l) => !l.startsWith(MASK));
  return { lines, masks, shown, output: shown.filter((l) => !l.startsWith("::debug::")) };
}

// The inverse of @actions/core's escapeData for command values.
const unescapeData = (s: string): string => s.replace(/%0D/g, "\r").replace(/%0A/g, "\n").replace(/%25/g, "%");

async function readJson(req: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of req) text += chunk;
  try {
    return text === "" ? undefined : JSON.parse(text);
  } catch {
    return text;
  }
}

function respond(res: ServerResponse, answer: Answer): void {
  if (answer === "hang") return;
  if (answer === "drop") return void res.socket?.destroy();
  const body = answer.text ?? (answer.json === undefined ? "" : JSON.stringify(answer.json));
  const type = answer.json === undefined ? {} : { "content-type": "application/json" };
  res.writeHead(answer.status, { ...type, ...answer.headers }).end(body);
}
