import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { specValidator } from "./spec.ts";

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

export type Fake = {
  readonly origin: string;
  /** Can be changed between requests. */
  readonly script: Script;
  readonly seen: Seen[];
  readonly problems: string[];
  readonly oidcEnv: { ACTIONS_ID_TOKEN_REQUEST_URL: string; ACTIONS_ID_TOKEN_REQUEST_TOKEN: string };
  reports(): unknown[];
  close(): Promise<void>;
};

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

  return {
    origin,
    script,
    seen,
    problems,
    oidcEnv: { ACTIONS_ID_TOKEN_REQUEST_URL: `${origin}/token?api-version=2.0`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN },
    reports: () => seen.filter((s) => s.op === "report").map((s) => s.body),
    close: async () => {
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

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
