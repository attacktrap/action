import * as core from "@actions/core";
import { BUDGET_MS } from "./main.ts";
import type { Pipeline } from "./pipeline/check.ts";
import type { Project } from "./project.ts";
import { SKIPS, type SkipCode } from "./warnings.ts";
import type { WriteStatus } from "./workspace.ts";

// A plain constant, never read from the environment: the job's env must not be able to send the
// Action's token anywhere else. Tests reach a local server through serverAt().
export const API_BASE_URL = "https://app.attacktrap.com";

const ACTION_VERSION = "1.0.0";
const AUDIENCE = "attacktrap";
const CALL_MS = 20_000;
// The supervisor kills the worker BUDGET_MS after it starts. Stop talking to the server this long
// before that, so a slow call still ends in this run's own line instead of `timed_out`.
const RESERVE_MS = 2_000;

/** Where the server is, and how long to wait. Every call stops at `callMs` or `deadline`, whichever comes first. */
export type Server = { readonly origin: string; readonly callMs: number; readonly deadline: AbortSignal };

export function serverAt(origin = API_BASE_URL, { callMs = CALL_MS, budgetMs = BUDGET_MS } = {}): Server {
  return { origin, callMs, deadline: AbortSignal.timeout(Math.max(0, Math.floor(budgetMs - RESERVE_MS - performance.now()))) };
}

/** What the server asked for. By the time a caller holds one, its path and every mask value are masked. */
export type Place = { readonly placementId: string; readonly path: string; readonly content: string };

/** A token for the server's audience, already masked by core, or undefined on any failure. */
export async function getToken(server: Server): Promise<string | undefined> {
  try {
    return await bounded(server, core.getIDToken(AUDIENCE));
  } catch {
    return undefined;
  }
}

/**
 * Anything but a 200 JSON reply that matches the spec exactly is `server_unreachable`. A skip comes
 * back as its code alone, so its message and url never leave this module.
 */
export async function requestCanary(
  server: Server,
  token: string,
  about: { pipeline: Pipeline; project: Project },
): Promise<Place | SkipCode | "server_unreachable"> {
  let reply: Offer | SkipCode | undefined;
  try {
    const body = { action_version: ACTION_VERSION, pipeline: about.pipeline, project: about.project };
    const res = await post(server, token, "/v1/canaries", body);
    if (res.status === 200 && isJson(res.headers.get("content-type"))) reply = parseReply(JSON.parse(await res.text()));
  } catch {}
  if (reply === undefined) return "server_unreachable";
  if (typeof reply === "string") return reply;
  for (const value of [...reply.mask, reply.path]) if (value !== "") core.setSecret(value);
  return { placementId: reply.placementId, path: reply.path, content: reply.content };
}

/** Sends `status` with a fresh token. Never throws, never prints, and ignores every failure. */
export async function reportPlacement(server: Server, place: Place, status: WriteStatus): Promise<void> {
  const token = await getToken(server);
  if (token === undefined) return;
  try {
    const res = await post(server, token, `/v1/placements/${encodeURIComponent(place.placementId)}/result`, { status });
    await res.body?.cancel();
  } catch {}
}

function post(server: Server, token: string, route: string, body: object): Promise<Response> {
  return fetch(new URL(route, server.origin), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: callSignal(server),
  });
}

const callSignal = (server: Server): AbortSignal => AbortSignal.any([AbortSignal.timeout(server.callMs), server.deadline]);

// core.getIDToken takes no signal and retries some failures for about 10 s, so race it. The
// handlers go on `work` first, so its late rejection is never unhandled in the worker.
function bounded<T>(server: Server, work: Promise<T>): Promise<T> {
  const signal = callSignal(server);
  return new Promise<T>((resolve, reject) => {
    work.then(resolve, reject);
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

// The wire Place. Only requestCanary sees the mask values, and it masks them before it returns.
type Offer = { placementId: string; path: string; content: string; mask: string[] };
type Json = Record<string, unknown>;

function parseReply(body: unknown): Offer | SkipCode | undefined {
  if (!isObject(body)) return undefined;
  if (body.result === "place" && closed(body, ["result", "placementId", "path", "content", "mask"])) {
    const { placementId, path, content, mask } = body;
    if (isText(placementId, 1) && isText(path, 1) && isText(content) && Array.isArray(mask) && mask.every((m) => isText(m))) {
      return { placementId, path, content, mask };
    }
  }
  if (body.result === "skip" && closed(body, ["result", "code", "message"], ["url"])) {
    const { code, message, url } = body;
    if (isSkipCode(code) && isText(message) && (!Object.hasOwn(body, "url") || isUri(url))) return code;
  }
  return undefined;
}

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown, minLength = 0): v is string => typeof v === "string" && v.length >= minLength;
const isSkipCode = (v: unknown): v is SkipCode => typeof v === "string" && Object.hasOwn(SKIPS, v);
const isJson = (type: string | null): boolean => /^application\/json\s*(;|$)/i.test(type ?? "");

// Every required key present and no other key outside `optional` (additionalProperties: false).
function closed(v: Json, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((k) => Object.hasOwn(v, k)) && Object.keys(v).every((k) => required.includes(k) || optional.includes(k));
}

// JSON Schema `format: uri`: a scheme, then only the characters RFC 3986 allows, with valid
// percent-escapes. test/api.test.ts compares it with ajv-formats over a corpus.
const isUri = (v: unknown): boolean =>
  typeof v === "string" &&
  /^[a-z][a-z0-9+.-]*:[a-z0-9\-._~:/?#[\]@!$&'()*+,;=%]*$/i.test(v) &&
  !/%(?![0-9a-f]{2})/i.test(v) &&
  URL.canParse(v);
