import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { findCall, makeRecipes, type Call } from "./calls.ts";
import { actionName, commands, hasPrefix, isKnownAction, matchAction, matchScript, OWN_ACTION, type Finding } from "./rules.ts";

export type { Finding, ToolId } from "./rules.ts";

export type RunnerEnv = {
  workspace: string | undefined; // GITHUB_WORKSPACE
  repository: string | undefined; // GITHUB_REPOSITORY, `owner/repo`
  workflowRef: string | undefined; // GITHUB_WORKFLOW_REF
  jobWorkflowRef: string | undefined; // job_workflow_ref from the OIDC token, used only to find a file
  job: string | undefined; // GITHUB_JOB
  action: string | undefined; // GITHUB_ACTION
};

export type Pipeline = { findings: Finding[]; incomplete: boolean };

const UNREADABLE: Pipeline = { findings: [{ kind: "unreadable", tool: "unknown" }], incomplete: false };
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 200;
const MAX_STEP_ID = 100;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const get = (v: unknown, key: string): unknown => (isObj(v) && Object.hasOwn(v, key) ? v[key] : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function values(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isObj(v)) {
    for (const [key, value] of Object.entries(v)) {
      if (["string", "number", "boolean"].includes(typeof value)) out[key] = String(value);
    }
  }
  return out;
}

class Unreadable extends Error {}

type Scope = { dir: string; context: string[]; nested: boolean; actionPath?: string };

// Checks the steps that run after this one and can see its checkout. Reads files only inside the
// workspace and never returns or logs anything read from them.
export function checkPipeline(env: RunnerEnv): Pipeline {
  try {
    return check(env);
  } catch {
    return { findings: [...UNREADABLE.findings], incomplete: false };
  }
}

function check(env: RunnerEnv): Pipeline {
  const { workspace, repository, workflowRef, job } = env;
  if (!workspace || !repository || !workflowRef || !job) throw new Unreadable();
  const walk = new Walk(workspace, repository);

  const top = repoPath(workflowRef, repository);
  if (top === undefined) throw new Unreadable();
  let own = top;
  let caller: string | undefined;
  if (env.jobWorkflowRef) {
    const called = repoPath(env.jobWorkflowRef, repository);
    if (called === undefined) throw new Unreadable();
    if (called !== top) [own, caller] = [called, top];
  }

  const workflow = walk.workflow(own) ?? walk.fail();
  const jobs = get(workflow, "jobs") as Obj;
  const steps = get(jobs[job], "steps");
  if (!Array.isArray(steps)) throw new Unreadable();
  const step = ownStep(steps, env.action);
  if (step === undefined) throw new Unreadable();
  if (!step.certain) walk.incomplete = true;

  walk.steps(steps.slice(step.index + 1), walk.jobScope(workflow, jobs[job]));
  for (const id of dependents(jobs, [job])) walk.job(workflow, jobs[id], false);

  if (caller !== undefined) {
    const callerWorkflow = walk.workflow(caller) ?? walk.fail();
    const callerJobs = get(callerWorkflow, "jobs") as Obj;
    const calling = Object.keys(callerJobs).filter((id) => {
      const uses = str(get(callerJobs[id], "uses"));
      return uses !== undefined && walk.workflowCall(uses) === own;
    });
    if (calling.length === 0) walk.incomplete = true;
    for (const id of dependents(callerJobs, calling)) walk.job(callerWorkflow, callerJobs[id], false);
  }
  return walk.result();
}

// `owner/repo/some/path@ref` to `some/path`, or undefined for another repo.
function repoPath(ref: string, repository: string): string | undefined {
  const at = ref.lastIndexOf("@");
  const name = at === -1 ? ref : ref.slice(0, at);
  const prefix = `${repository}/`;
  if (name.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return undefined;
  return path.posix.normalize(name.slice(prefix.length));
}

// The step whose id is GITHUB_ACTION, or else the only use of this action in the job. With several
// uses and no id to tell them apart, it's the last one, and uncertain because the steps between
// them may run later.
function ownStep(steps: unknown[], action: string | undefined): { index: number; certain: boolean } | undefined {
  const byId = action ? stepIds(steps).findIndex((id) => id.toLowerCase() === action.toLowerCase()) : -1;
  if (byId !== -1) return { index: byId, certain: true };
  const own = steps.flatMap((s, i) => {
    const uses = str(get(s, "uses"));
    return uses !== undefined && hasPrefix(actionName(uses), OWN_ACTION) ? [i] : [];
  });
  return own.length === 0 ? undefined : { index: own[own.length - 1], certain: own.length === 1 };
}

// The id GitHub gives each step: its `id`, or else `__` and the action's `owner_repo`, `self` for a
// local action, the image for `docker://`, or `run`. A name already used in the job, ignoring case,
// gets `_2`, `_3` and so on. Written ids can't start with `__`, so the two never clash.
export function stepIds(steps: unknown[]): string[] {
  const taken = new Set<string>();
  return steps.map((step) => {
    const id = str(get(step, "id"));
    if (id) return id;
    const base = `__${defaultName(str(get(step, "uses")))}`.replace(/[^\w-]/g, "_");
    for (let n = 1; ; n++) {
      const suffix = n === 1 ? "" : `_${n}`;
      const candidate = base.slice(0, MAX_STEP_ID - suffix.length) + suffix;
      if (!taken.has(candidate.toLowerCase())) {
        taken.add(candidate.toLowerCase());
        return candidate;
      }
    }
  });
}

function defaultName(uses: string | undefined): string {
  if (uses === undefined) return "run";
  if (uses.startsWith("docker://")) return uses.slice("docker://".length);
  if (uses.startsWith("./") || uses.startsWith(".\\")) return "self";
  const [name, ref, ...rest] = uses.split("@");
  const parts = name.split(/[/\\]/).filter(Boolean);
  return ref && rest.length === 0 && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : "run";
}

// Jobs that depend on any of `roots` through `needs`, directly or transitively.
function dependents(jobs: Obj, roots: string[]): string[] {
  const later = new Set<string>();
  const reached = new Set(roots);
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of Object.keys(jobs)) {
      if (reached.has(id)) continue;
      const needs = get(jobs[id], "needs");
      const list = typeof needs === "string" ? [needs] : Array.isArray(needs) ? needs : [];
      if (list.some((n) => typeof n === "string" && reached.has(n))) {
        reached.add(id);
        later.add(id);
        changed = true;
      }
    }
  }
  return [...later];
}

class Walk {
  readonly findings: Finding[] = [];
  incomplete = false;
  private reads = 0;
  private readonly root: string;
  private readonly repository: string;

  constructor(workspace: string, repository: string) {
    this.root = realpathSync(workspace);
    this.repository = repository;
  }

  fail(): never {
    throw new Unreadable();
  }

  result(): Pipeline {
    const seen = new Set<string>();
    const findings = this.findings.filter((f) => {
      const key = `${f.kind}:${f.tool}`;
      return !seen.has(key) && Boolean(seen.add(key));
    });
    return { findings, incomplete: this.incomplete };
  }

  // A file inside the workspace, or undefined if it is missing, outside or too large.
  read(relative: string): string | undefined {
    if (++this.reads > MAX_FILES) return undefined;
    try {
      const real = realpathSync(path.resolve(this.root, relative));
      const inside = path.relative(this.root, real);
      if (inside.startsWith("..") || path.isAbsolute(inside)) return undefined;
      const stat = statSync(real);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
      return readFileSync(real, "utf8");
    } catch {
      return undefined;
    }
  }

  yaml(relative: string): unknown {
    const text = this.read(relative);
    if (text === undefined) return undefined;
    try {
      return parse(text);
    } catch {
      return undefined;
    }
  }

  json(relative: string): unknown {
    const text = this.read(relative);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  workflow(relative: string): Obj | undefined {
    const workflow = this.yaml(relative);
    return isObj(workflow) && isObj(get(workflow, "jobs")) ? workflow : undefined;
  }

  // The repo path of a job-level `uses:`, or undefined for another repo.
  workflowCall(uses: string): string | undefined {
    if (uses.startsWith("./")) return path.posix.normalize(uses);
    return repoPath(uses, this.repository);
  }

  jobScope(workflow: Obj, job: unknown): Scope {
    const dir = str(get(get(get(job, "defaults"), "run"), "working-directory"));
    const workflowDir = str(get(get(get(workflow, "defaults"), "run"), "working-directory"));
    const context = [...Object.values(values(get(workflow, "env"))), ...Object.values(values(get(job, "env")))];
    return { dir: dir ?? workflowDir ?? ".", context, nested: false };
  }

  job(workflow: Obj, job: unknown, nested: boolean): void {
    const uses = str(get(job, "uses"));
    if (uses !== undefined) {
      const called = nested || uses.includes("${{") ? undefined : this.workflowCall(uses);
      const calledWorkflow = called === undefined ? undefined : this.workflow(called);
      if (calledWorkflow === undefined) {
        this.incomplete = true;
        return;
      }
      for (const calledJob of Object.values(get(calledWorkflow, "jobs") as Obj)) this.job(calledWorkflow, calledJob, true);
      return;
    }
    const steps = get(job, "steps");
    if (Array.isArray(steps)) this.steps(steps, this.jobScope(workflow, job));
  }

  steps(steps: unknown[], scope: Scope): void {
    for (const step of steps) this.step(step, scope);
  }

  private step(step: unknown, scope: Scope): void {
    const uses = str(get(step, "uses"));
    if (uses !== undefined) this.uses(uses, values(get(step, "with")), scope);
    const run = str(get(step, "run"));
    if (run !== undefined) {
      const dir = str(get(step, "working-directory"));
      const context = [...scope.context, ...Object.values(values(get(step, "env")))];
      this.script(this.expand(run, scope), { ...scope, dir: dir === undefined ? scope.dir : this.expand(dir, scope), context });
    }
  }

  private expand(text: string, scope: Scope): string {
    let out = text.replace(/\$\{\{\s*github\.workspace\s*\}\}|\$\{?GITHUB_WORKSPACE\}?/g, ".");
    if (scope.actionPath !== undefined) {
      out = out.replace(/\$\{\{\s*github\.action_path\s*\}\}|\$\{?GITHUB_ACTION_PATH\}?/g, scope.actionPath);
    }
    return out;
  }

  private uses(uses: string, inputs: Record<string, string>, scope: Scope): void {
    if (uses.includes("${{")) {
      this.incomplete = true;
    } else if (uses.startsWith("./") || uses.startsWith("../")) {
      if (scope.nested) this.incomplete = true;
      else this.localAction(path.posix.normalize(uses));
    } else if (uses.startsWith("docker://")) {
      this.findings.push(...matchScript(`${uses.slice("docker://".length)} ${inputs.args ?? ""}`));
    } else {
      this.findings.push(...matchAction(uses, inputs));
      if (!isKnownAction(uses)) this.incomplete = true;
    }
  }

  private localAction(dir: string): void {
    const action = this.yaml(`${dir}/action.yml`) ?? this.yaml(`${dir}/action.yaml`);
    const runs = get(action, "runs");
    const using = str(get(runs, "using"));
    const steps = get(runs, "steps");
    const image = str(get(runs, "image"));
    if (using === "composite" && Array.isArray(steps)) {
      this.steps(steps, { dir: ".", context: [], nested: true, actionPath: dir });
    } else if (using === "docker" && image?.startsWith("docker://")) {
      const args = get(runs, "args");
      const words = Array.isArray(args) ? args.filter((a) => typeof a === "string") : [];
      this.findings.push(...matchScript([image.slice("docker://".length), ...words].join(" ")));
    } else {
      this.incomplete = true;
    }
  }

  // Matches the text, then follows each call into the repo one level.
  private script(text: string, scope: Scope): void {
    this.findings.push(...matchScript(text, scope.context));
    for (const command of commands(text)) {
      const call = findCall(command, scope.dir);
      if (call === undefined) continue;
      if (scope.nested || call.kind === "unresolved") this.incomplete = true;
      else this.follow(call, scope);
    }
  }

  private follow(call: Exclude<Call, { kind: "unresolved" }>, scope: Scope): void {
    const nested: Scope = { ...scope, nested: true };
    if (call.kind === "file") {
      const text = this.read(path.posix.join(call.dir, call.path));
      if (text === undefined) this.incomplete = true;
      else this.script(text, nested);
    } else if (call.kind === "make") {
      const file = call.file ?? ["GNUmakefile", "makefile", "Makefile"].find((name) => this.read(path.posix.join(call.dir, name)) !== undefined);
      const text = file === undefined ? undefined : this.read(path.posix.join(call.dir, file));
      const recipes = text === undefined ? undefined : makeRecipes(text, call.targets);
      if (recipes === undefined) this.incomplete = true;
      else this.script(recipes, { ...nested, dir: call.dir });
    } else {
      const manifest = this.json(path.posix.join(call.dir, "package.json"));
      const scripts = get(manifest, "scripts");
      const found = call.names.map((name) => str(get(scripts, name)));
      const main = found[call.names.length === 1 ? 0 : 1];
      if (main === undefined && !call.ifPresent) this.incomplete = true;
      for (const text of found) if (text !== undefined) this.script(text, { ...nested, dir: call.dir });
    }
  }
}
