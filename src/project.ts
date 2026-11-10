import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

export type Manifest = { main?: string; type?: "commonjs" | "module"; bin?: string | Record<string, string>; files?: string[] };
export type Copy = { src: string[]; dest: string };
export type Stage = { from: string; workdir?: string; copies: Copy[] };
export type ImageBuild = { stages: Stage[]; ignore: string[] };
export type LambdaFunction = { code_uri: string; handler: string; runtime: string };
export type BuildTarget = { kind: "docker" | "lambda_zip"; path: string; context: string };
export type Project = {
  tree: string[];
  dependencies: { node: string[]; python: string[] };
  manifests: Record<string, Manifest>;
  docker: Record<string, ImageBuild>;
  lambda: Record<string, LambdaFunction[]>;
  build_targets: BuildTarget[];
};

export const MAX_TREE = 5000;
const MAX_FILE_BYTES = 1 << 20;
const SKIPPED_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv"]);
const NOT_PARSED_UNDER = ".github/";

const NODE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;
const PYTHON_NAME = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;
const NODE_DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

type Read = (file: string) => Promise<string | undefined>;
type Collected = Omit<Project, "tree" | "build_targets"> & { targets: BuildTarget[] };

export async function collectProject(root: string): Promise<Project> {
  const tree = await walk(root);
  const read: Read = (file) => readSmall(path.join(root, ...file.split("/")));
  const collected: Collected = { dependencies: { node: [], python: [] }, manifests: {}, docker: {}, lambda: {}, targets: [] };
  const inTree = new Set(tree);
  for (const file of tree) {
    if (file.startsWith(NOT_PARSED_UNDER)) continue;
    const collect = collectorFor(path.posix.basename(file));
    if (!collect) continue;
    const text = await read(file);
    if (text === undefined) continue;
    try {
      await collect(file, text, collected, inTree, read);
    } catch {}
  }
  return {
    tree,
    dependencies: { node: unique(collected.dependencies.node), python: unique(collected.dependencies.python) },
    manifests: collected.manifests,
    docker: collected.docker,
    lambda: collected.lambda,
    build_targets: uniqueTargets(collected.targets.filter((target) => inTree.has(target.path))),
  };
}

type Collector = (file: string, text: string, into: Collected, tree: Set<string>, read: Read) => void | Promise<void>;

function collectorFor(name: string): Collector | undefined {
  if (name === "package.json") return collectPackageJson;
  if (/^requirements.*\.txt$/i.test(name)) return collectRequirements;
  if (name === "pyproject.toml") return collectPyproject;
  if (name === "Pipfile") return collectPipfile;
  if (/^(?:Dockerfile|Containerfile)(?:\..+)?$|\.(?:Dockerfile|Containerfile)$/i.test(name)) return collectImageBuild;
  if (/^template\.(?:ya?ml|json)$/i.test(name)) return collectSamTemplate;
  if (/^serverless\.(?:ya?ml|json)$/i.test(name)) return collectServerless;
  return undefined;
}

async function walk(root: string): Promise<string[]> {
  const files: string[] = [];
  let dirs = [""];
  while (dirs.length > 0 && files.length < MAX_TREE) {
    const next: string[] = [];
    for (const dir of dirs) {
      let entries;
      try {
        entries = await readdir(path.join(root, ...dir.split("/")), { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const subdirs: string[] = [];
      for (const entry of entries) {
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isFile()) {
          if (files.length < MAX_TREE) files.push(rel);
        } else if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name) && !(await isVirtualEnv(root, rel))) {
          subdirs.push(rel);
        }
      }
      next.push(...subdirs);
    }
    dirs = next;
  }
  return files;
}

async function isVirtualEnv(root: string, dir: string): Promise<boolean> {
  try {
    return (await stat(path.join(root, ...dir.split("/"), "pyvenv.cfg"))).isFile();
  } catch {
    return false;
  }
}

async function readSmall(file: string): Promise<string | undefined> {
  try {
    if ((await stat(file)).size > MAX_FILE_BYTES) return undefined;
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

function collectPackageJson(file: string, text: string, into: Collected): void {
  const json: unknown = JSON.parse(text);
  if (!isRecord(json)) return;
  const manifest: Manifest = {};
  if (typeof json.main === "string") manifest.main = json.main;
  if (json.type === "commonjs" || json.type === "module") manifest.type = json.type;
  if (typeof json.bin === "string") manifest.bin = json.bin;
  else if (isRecord(json.bin)) manifest.bin = stringEntries(json.bin);
  if (Array.isArray(json.files)) manifest.files = json.files.filter((f): f is string => typeof f === "string");
  into.manifests[file] = manifest;
  for (const field of NODE_DEPENDENCY_FIELDS) {
    const deps = json[field];
    if (isRecord(deps)) into.dependencies.node.push(...Object.keys(deps).filter((name) => name.length <= 214 && NODE_NAME.test(name)));
  }
}

function collectRequirements(_file: string, text: string, into: Collected): void {
  for (const line of text.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    const name = requirementName(line.replace(/(^|\s)#.*$/, ""));
    if (name) into.dependencies.python.push(name);
  }
}

function collectPyproject(_file: string, text: string, into: Collected): void {
  const toml = parseToml(text) as Record<string, unknown>;
  const project = record(toml.project);
  const poetry = record(record(toml.tool).poetry);
  const uv = record(record(toml.tool).uv);
  const requirements = [
    ...strings(project.dependencies),
    ...Object.values(record(project["optional-dependencies"])).flatMap(strings),
    ...Object.values(record(toml["dependency-groups"])).flatMap(strings),
    ...strings(uv["dev-dependencies"]),
  ];
  const keys = [
    ...Object.keys(record(poetry.dependencies)),
    ...Object.keys(record(poetry["dev-dependencies"])),
    ...Object.values(record(poetry.group)).flatMap((group) => Object.keys(record(record(group).dependencies))),
  ].filter((name) => name.toLowerCase() !== "python");
  into.dependencies.python.push(...pythonNames(requirements, keys));
}

function collectPipfile(_file: string, text: string, into: Collected): void {
  const toml = parseToml(text) as Record<string, unknown>;
  const keys = [...Object.keys(record(toml.packages)), ...Object.keys(record(toml["dev-packages"]))];
  into.dependencies.python.push(...pythonNames([], keys));
}

function pythonNames(requirements: string[], keys: string[]): string[] {
  const names = requirements.map(requirementName);
  for (const key of keys) if (PYTHON_NAME.test(key)) names.push(normalizePython(key));
  return names.filter((name): name is string => name !== undefined);
}

function requirementName(requirement: string): string | undefined {
  const match = /^\s*([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)\s*(?:$|[[<>=!~;@(,\s])/i.exec(requirement);
  return match ? normalizePython(match[1]) : undefined;
}

function normalizePython(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

async function collectImageBuild(file: string, text: string, into: Collected, tree: Set<string>, read: Read): Promise<void> {
  const dir = path.posix.dirname(file);
  const stages = reduceImageBuild(text);
  const ignoreFile = [`${file}.dockerignore`, dir === "." ? ".dockerignore" : `${dir}/.dockerignore`].find((f) => tree.has(f));
  const ignoreText = ignoreFile ? await read(ignoreFile) : undefined;
  const ignore = (ignoreText ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  into.docker[file] = { stages, ignore };
  into.targets.push({ kind: "docker", path: file, context: dir });
}

export function reduceImageBuild(text: string): Stage[] {
  const stages: Stage[] = [];
  for (const { keyword, args } of instructions(text)) {
    const stage = stages.at(-1);
    if (keyword === "FROM") {
      const image = args.split(/\s+/).find((token) => token && !token.startsWith("--"));
      if (image) stages.push({ from: image, copies: [] });
    } else if (!stage) {
      continue;
    } else if (keyword === "WORKDIR" && args) {
      stage.workdir = stage.workdir && !args.startsWith("/") ? path.posix.join(stage.workdir, args) : args;
    } else if (keyword === "COPY" || keyword === "ADD") {
      const copy = reduceCopy(args);
      if (copy) stage.copies.push(copy);
    }
  }
  return stages;
}

function reduceCopy(args: string): Copy | undefined {
  const flags: string[] = [];
  let rest = args;
  for (let match; (match = /^(--\S+)\s*/.exec(rest)); rest = rest.slice(match[0].length)) flags.push(match[1]);
  if (flags.some((flag) => /^--from(?:=|$)/.test(flag))) return undefined;
  let parts: unknown = undefined;
  if (rest.startsWith("[")) {
    try {
      parts = JSON.parse(rest);
    } catch {}
  }
  const tokens = Array.isArray(parts) && parts.every((p) => typeof p === "string") ? (parts as string[]) : rest.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return undefined;
  const dest = tokens.at(-1)!;
  const src = tokens.slice(0, -1).filter((s) => !s.includes("://") && !s.startsWith("git@") && !s.startsWith("<<"));
  return src.length > 0 ? { src, dest } : undefined;
}

function* instructions(text: string): Generator<{ keyword: string; args: string }> {
  const lines = text.split(/\r?\n/);
  let escape = "\\";
  let i = 0;
  for (; i < lines.length; i++) {
    const directive = /^\s*#\s*([a-z]+)\s*=\s*(\S+)\s*$/i.exec(lines[i]);
    if (!directive) break;
    if (directive[1].toLowerCase() === "escape" && (directive[2] === "`" || directive[2] === "\\")) escape = directive[2];
  }
  while (i < lines.length) {
    let logical = "";
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*#/.test(line)) continue;
      const trimmed = line.trimEnd();
      if (!trimmed.endsWith(escape)) {
        logical += line;
        i++;
        break;
      }
      logical += trimmed.slice(0, -1) + " ";
    }
    const match = /^\s*([a-z]+)\s*(.*)$/is.exec(logical);
    if (!match) continue;
    const keyword = match[1].toUpperCase();
    for (const heredoc of match[2].matchAll(/<<(-?)(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/g)) {
      const strip = heredoc[1] === "-";
      while (i < lines.length && (strip ? lines[i].replace(/^\t+/, "") : lines[i]) !== heredoc[3]) i++;
      i++;
    }
    yield { keyword, args: match[2].trim() };
  }
}

function collectSamTemplate(file: string, text: string, into: Collected): void {
  const template = record(parseDocument(file, text));
  const transforms = Array.isArray(template.Transform) ? template.Transform : [template.Transform];
  if (!transforms.some((t) => typeof t === "string" && t.startsWith("AWS::Serverless"))) return;
  const globals = record(record(template.Globals).Function);
  const functions: LambdaFunction[] = [];
  for (const resource of Object.values(record(template.Resources))) {
    if (record(resource).Type !== "AWS::Serverless::Function") continue;
    const props = { ...globals, ...record(record(resource).Properties) };
    addFunction(functions, props.CodeUri, props.Handler, props.Runtime);
  }
  addFunctions(file, functions, into);
}

function collectServerless(file: string, text: string, into: Collected): void {
  const config = record(parseDocument(file, text));
  const provider = record(config.provider);
  const servicePackage = record(config.package);
  const functions: LambdaFunction[] = [];
  for (const fn of Object.values(record(config.functions))) {
    const props = record(fn);
    const artifact = record(props.package).artifact ?? servicePackage.artifact ?? ".";
    addFunction(functions, artifact, props.handler, props.runtime ?? provider.runtime);
  }
  addFunctions(file, functions, into);
}

function addFunction(functions: LambdaFunction[], code_uri: unknown, handler: unknown, runtime: unknown): void {
  if (typeof code_uri === "string" && typeof handler === "string" && typeof runtime === "string") {
    functions.push({ code_uri, handler, runtime });
  }
}

function addFunctions(file: string, functions: LambdaFunction[], into: Collected): void {
  if (functions.length === 0) return;
  into.lambda[file] = functions;
  const dir = path.posix.dirname(file);
  for (const { code_uri } of functions) {
    const context = path.posix.normalize(path.posix.join(dir, code_uri)).replace(/(.)\/+$/, "$1");
    if (context !== ".." && !context.startsWith("../")) into.targets.push({ kind: "lambda_zip", path: file, context });
  }
}

function parseDocument(file: string, text: string): unknown {
  return file.endsWith(".json") ? JSON.parse(text) : parseYaml(text, { logLevel: "silent", customTags: CLOUDFORMATION_TAGS });
}

const CLOUDFORMATION_TAGS = ["Ref", "Sub", "GetAtt", "Join", "If", "Select", "Split", "FindInMap", "ImportValue", "Base64", "GetAZs", "Cidr", "Equals", "And", "Or", "Not", "Condition", "Transform"].flatMap(
  (name) =>
    (["scalar", "seq", "map"] as const).map((nodeClass) => ({
      tag: `!${name}`,
      collection: nodeClass === "scalar" ? undefined : nodeClass,
      resolve: () => ({ [`Fn::${name}`]: null }),
    })),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function stringEntries(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function uniqueTargets(targets: BuildTarget[]): BuildTarget[] {
  const seen = new Map(targets.map((t) => [`${t.kind}\0${t.path}\0${t.context}`, t]));
  return [...seen.values()];
}
