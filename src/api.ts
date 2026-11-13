import * as core from "@actions/core";
import { BUDGET_MS } from "./main.ts";
import type { Pipeline } from "./pipeline/check.ts";
import type { Project } from "./project.ts";
import { SKIPS, type SkipCode } from "./warnings.ts";
import type { WriteStatus } from "./workspace.ts";

export const API_BASE_URL = "https://app.attacktrap.com";

const ACTION_VERSION = "1.0.0";
const AUDIENCE = "attacktrap";
const CALL_MS = 20_000;
const MARGIN_BEFORE_KILL_MS = 2_000;

export type Server = { readonly origin: string; readonly callMs: number; readonly deadline: AbortSignal };

export function serverAt(origin = API_BASE_URL, { callMs = CALL_MS, budgetMs = BUDGET_MS } = {}): Server {
  return { origin, callMs, deadline: AbortSignal.timeout(Math.max(0, Math.floor(budgetMs - MARGIN_BEFORE_KILL_MS - performance.now()))) };
}

export type Place = { readonly placementId: string; readonly path: string; readonly content: string };

export async function getToken(server: Server): Promise<string | undefined> {
  try {
    return await bounded(server, core.getIDToken(AUDIENCE));
  } catch {
    return undefined;
  }
}

export async function requestCanary(
  server: Server,
  token: string,
  about: { pipeline: Pipeline; project: Project },
): Promise<Place | SkipCode | "server_unreachable"> {
  let reply: UnmaskedPlace | SkipCode | undefined;
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

// core.getIDToken takes no signal and retries some failures for about 10 s, so race it.
function bounded<T>(server: Server, work: Promise<T>): Promise<T> {
  const signal = callSignal(server);
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  return Promise.race([work, aborted]);
}

type UnmaskedPlace = { placementId: string; path: string; content: string; mask: string[] };
type Json = Record<string, unknown>;

function parseReply(body: unknown): UnmaskedPlace | SkipCode | undefined {
  if (!isObject(body)) return undefined;
  if (body.result === "place" && hasExactKeys(body, ["result", "placementId", "path", "content", "mask"])) {
    const { placementId, path, content, mask } = body;
    if (isText(placementId, 1) && isText(path, 1) && isText(content) && Array.isArray(mask) && mask.every((m) => isText(m))) {
      return { placementId, path, content, mask };
    }
  }
  if (body.result === "skip" && hasExactKeys(body, ["result", "code", "message"], ["url"])) {
    const { code, message, url } = body;
    // `format: uri` is only an annotation in JSON Schema 2020-12, and the Action never reads `url`.
    if (isSkipCode(code) && isText(message) && (!Object.hasOwn(body, "url") || isText(url))) return code;
  }
  return undefined;
}

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown, minLength = 0): v is string => typeof v === "string" && v.length >= minLength;
const isSkipCode = (v: unknown): v is SkipCode => typeof v === "string" && Object.hasOwn(SKIPS, v);
const isJson = (type: string | null): boolean => /^application\/json\s*(;|$)/i.test(type ?? "");

function hasExactKeys(v: Json, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((k) => Object.hasOwn(v, k)) && Object.keys(v).every((k) => required.includes(k) || optional.includes(k));
}
