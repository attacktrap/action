// Recognises a command that runs something else in the repo: a Makefile target, a package.json
// script or a script file.

export type Call =
  | { kind: "file"; dir: string; path: string }
  | { kind: "make"; dir: string; file: string | undefined; targets: string[] }
  | { kind: "script"; dir: string; names: string[]; ifPresent: boolean }
  | { kind: "unresolved" };

const PREFIXES = ["sudo", "time", "exec", "env", "command", "nohup"];
// Interpreters, and the flags that make them run inline code or a module instead of a file.
const INTERPRETERS: Record<string, string[]> = {
  bash: ["-c"],
  sh: ["-c"],
  zsh: ["-c"],
  dash: ["-c"],
  python: ["-c", "-m"],
  node: ["-e", "-p", "--eval", "--print"],
  ruby: ["-e"],
  perl: ["-e", "-E"],
  pwsh: ["-c", "-Command", "-command"],
};
const NPM_RUN = ["run", "run-script", "rum", "urn"];
const NPM_SHORTCUTS: Record<string, string> = { test: "test", t: "test", tst: "test", start: "start", stop: "stop", restart: "restart" };
const YARN_BUILTINS = new Set(
  (
    "add audit autoclean bin cache check config constraints create dedupe dlx exec explain generate-lock-entry " +
    "global help import info init install licenses link list login logout node npm outdated owner pack patch " +
    "plugin policies publish rebuild remove search set stage tag team unlink unplug up upgrade " +
    "upgrade-interactive version versions why workspace workspaces"
  ).split(" "),
);
const PNPM_BUILTINS = new Set(
  (
    "add i install update up remove rm uninstall link ln unlink import rebuild rb prune fetch patch patch-commit " +
    "exec dlx create publish pack audit list ls outdated why store env setup config init deploy server licenses " +
    "root bin doctor cache approve-builds self-update ci install-test it recursive dedupe"
  ).split(" "),
);

const isFlag = (word: string) => word.startsWith("-");
const dynamic = (word: string) => word.includes("$") || word.includes("%");

function base(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1).replace(/\.exe$/i, "");
}

// Reads `--name value`, `--name=value` or `-Xvalue` for any of `names`, and returns what is left.
function takeOption(words: string[], names: string[]): { value: string | undefined; rest: string[] } {
  let value: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const name = names.find((n) => word === n || word.startsWith(`${n}=`) || (n.length === 2 && word.startsWith(n)));
    if (name === undefined) rest.push(word);
    else if (word === name) value = words[++i] ?? "";
    else value = word.slice(word.startsWith(`${name}=`) ? name.length + 1 : name.length);
  }
  return { value, rest };
}

function join(dir: string, sub: string | undefined): string {
  return sub === undefined ? dir : `${dir}/${sub}`;
}

export function findCall(command: string[], dir: string): Call | undefined {
  let words = command;
  while (words[0] !== undefined && (PREFIXES.includes(words[0]) || /^\w+=/.test(words[0]))) {
    words = words.slice(1);
    while (words[0] !== undefined && isFlag(words[0])) words = words.slice(1);
  }
  const [head, ...rest] = words;
  if (head === undefined) return undefined;
  const name = base(head);

  if (name === "make" || name === "gmake") {
    const c = takeOption(rest, ["-C", "--directory"]);
    const f = takeOption(c.rest, ["-f", "--file", "--makefile"]);
    const targets = f.rest.filter((w) => !isFlag(w) && !w.includes("=") && !/^\d+$/.test(w));
    if ([c.value, f.value, ...targets].some((w) => w !== undefined && dynamic(w))) return { kind: "unresolved" };
    return { kind: "make", dir: join(dir, c.value), file: f.value, targets };
  }

  if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") {
    if (rest.some((w) => ["-w", "--workspace", "--workspaces", "-ws", "-r", "--recursive", "--filter", "-F"].some((f) => w === f || w.startsWith(`${f}=`)))) {
      return { kind: "unresolved" };
    }
    const d = takeOption(rest, name === "yarn" ? ["--cwd"] : name === "npm" ? ["--prefix"] : ["-C", "--dir", "--cwd"]);
    const ifPresent = d.rest.includes("--if-present");
    const positional = d.rest.filter((w) => !isFlag(w));
    const [sub, next] = positional;
    let script: string | undefined;
    if (sub === undefined) return undefined;
    if (NPM_RUN.includes(sub)) script = next;
    else if ((name === "npm" || name === "pnpm") && Object.hasOwn(NPM_SHORTCUTS, sub)) script = NPM_SHORTCUTS[sub];
    if (script === undefined && name === "yarn" && !YARN_BUILTINS.has(sub)) script = sub;
    if (script === undefined && name === "pnpm" && !PNPM_BUILTINS.has(sub) && !Object.hasOwn(NPM_SHORTCUTS, sub)) script = sub;
    if (script === undefined) return undefined;
    if ([script, d.value].some((w) => w !== undefined && dynamic(w))) return { kind: "unresolved" };
    if (name === "bun" && /\.[cm]?[jt]sx?$/.test(script)) return { kind: "file", dir, path: script };
    const names = name === "npm" || name === "pnpm" ? [`pre${script}`, script, `post${script}`] : [script];
    return { kind: "script", dir: join(dir, d.value), names, ifPresent };
  }

  const interpreter = name.replace(/[\d.]+$/, "");
  const inline = Object.hasOwn(INTERPRETERS, interpreter) ? INTERPRETERS[interpreter] : undefined;
  if (inline) {
    for (const word of rest) {
      if (inline.includes(word)) return undefined;
      if (isFlag(word)) continue;
      return dynamic(word) ? { kind: "unresolved" } : { kind: "file", dir, path: word };
    }
    return undefined;
  }

  if (head.startsWith("$")) return { kind: "unresolved" };
  if (head.startsWith("./") || head.startsWith("../") || (head.includes("/") && !head.startsWith("/") && !head.startsWith("~"))) {
    return dynamic(head) ? { kind: "unresolved" } : { kind: "file", dir, path: head };
  }
  return undefined;
}

// The recipe lines of `targets` and their prerequisites, or undefined if a target is missing.
// No targets means the first target in the file.
export function makeRecipes(text: string, targets: string[]): string | undefined {
  const rules = new Map<string, { deps: string[]; recipe: string[] }>();
  let first: string | undefined;
  let current: { deps: string[]; recipe: string[] }[] = [];
  for (const line of text.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    if (line.startsWith("\t")) {
      for (const rule of current) rule.recipe.push(line.slice(1).replace(/^[@+-]+/, ""));
      continue;
    }
    const match = /^([^\s:=#][^:=#]*?)\s*::?(?!=)(.*)$/.exec(line);
    if (!match) {
      if (line.trim() !== "" && !line.trim().startsWith("#")) current = [];
      continue;
    }
    const [depsPart, inline] = match[2].split(";", 2);
    const names = match[1].split(/\s+/).filter((n) => n !== "");
    current = [];
    for (const name of names) {
      const rule = rules.get(name) ?? { deps: [], recipe: [] };
      rule.deps.push(...depsPart.split(/\s+/).filter((d) => d !== "" && !d.startsWith("|")));
      if (inline !== undefined) rule.recipe.push(inline.trim());
      rules.set(name, rule);
      current.push(rule);
      if (first === undefined && !name.startsWith(".") && !name.includes("%")) first = name;
    }
  }
  const wanted = targets.length > 0 ? targets : first === undefined ? [] : [first];
  if (wanted.length === 0) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  const visit = (name: string, required: boolean): boolean => {
    if (seen.has(name)) return true;
    seen.add(name);
    const rule = rules.get(name);
    if (!rule) return !required;
    for (const dep of rule.deps) visit(dep, false);
    out.push(...rule.recipe);
    return true;
  };
  for (const name of wanted) if (!visit(name, true)) return undefined;
  return out.join("\n");
}
