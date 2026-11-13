// Publisher and scanner rules. Every name here is published in the README.

export type ToolId =
  | "npm"
  | "pypi"
  | "poetry"
  | "uv"
  | "ecr_public"
  | "gh_release"
  | "gh_artifact"
  | "gh_pages"
  | "git_commit"
  | "trufflehog"
  | "gitleaks"
  | "ggshield"
  | "trivy"
  | "snyk"
  | "semgrep"
  | "checkov"
  | "docker_scout"
  | "aws_inspector"
  | "unknown";

export type Finding = { kind: "public_publish" | "scanner" | "unreadable"; tool: ToolId };

const publish = (tool: ToolId): Finding => ({ kind: "public_publish", tool });
const scanner = (tool: ToolId): Finding => ({ kind: "scanner", tool });

type Inputs = Record<string, string>;

// `uses:` prefixes, matched on `owner/repo[/path]` without the `@ref`, ignoring case.
const ACTIONS: [prefix: string, match: (inputs: Inputs) => Finding | undefined][] = [
  ["js-devtools/npm-publish", () => publish("npm")],
  ["pypa/gh-action-pypi-publish", () => publish("pypi")],
  ["softprops/action-gh-release", () => publish("gh_release")],
  ["actions/upload-artifact", () => publish("gh_artifact")],
  ["actions/deploy-pages", () => publish("gh_pages")],
  ["actions/upload-pages-artifact", () => publish("gh_pages")],
  ["peaceiris/actions-gh-pages", () => publish("gh_pages")],
  ["stefanzweifel/git-auto-commit-action", () => publish("git_commit")],
  ["endbug/add-and-commit", () => publish("git_commit")],
  ["ad-m/github-push-action", () => publish("git_commit")],
  ["peter-evans/create-pull-request", () => publish("git_commit")],
  ["trufflesecurity/trufflehog", () => scanner("trufflehog")],
  ["gitleaks/gitleaks-action", () => scanner("gitleaks")],
  ["gitguardian/ggshield-action", () => scanner("ggshield")],
  ["gitguardian/ggshield", () => scanner("ggshield")],
  ["aquasecurity/trivy-action", (inputs) => (trivyScansSecrets(inputs.scanners) ? scanner("trivy") : undefined)],
  ["snyk/actions", () => scanner("snyk")],
  ["returntocorp/semgrep-action", () => scanner("semgrep")],
  ["semgrep/semgrep-action", () => scanner("semgrep")],
  ["bridgecrewio/checkov-action", () => scanner("checkov")],
  ["docker/scout-action", (inputs) => (isTrue(inputs.secrets) ? scanner("docker_scout") : undefined)],
  ["aws-actions/vulnerability-scan-github-action-for-amazon-inspector", () => scanner("aws_inspector")],
];

export const OWN_ACTION = "attacktrap/action";

// Remote actions known not to run steps of their own. Any other remote action may be a composite
// action, which the check can't read, so it makes the check incomplete.
const KNOWN_ACTIONS = [
  "actions/checkout",
  "actions/setup-node",
  "actions/setup-python",
  "actions/setup-go",
  "actions/setup-java",
  "actions/setup-dotnet",
  "actions/cache",
  "actions/download-artifact",
  "actions/github-script",
  "actions/configure-pages",
  "actions/create-github-app-token",
  "astral-sh/setup-uv",
  "pnpm/action-setup",
  "oven-sh/setup-bun",
  "docker/setup-buildx-action",
  "docker/setup-qemu-action",
  "docker/login-action",
  "docker/metadata-action",
  "docker/build-push-action",
  "aws-actions/amazon-ecr-login",
  "aws-actions/configure-aws-",
  OWN_ACTION,
];

export function actionName(uses: string): string {
  const at = uses.indexOf("@");
  return (at === -1 ? uses : uses.slice(0, at)).toLowerCase();
}

export function hasPrefix(name: string, prefix: string): boolean {
  return name === prefix || name.startsWith(prefix.endsWith("-") ? prefix : `${prefix}/`);
}

export function isKnownAction(uses: string): boolean {
  const name = actionName(uses);
  return KNOWN_ACTIONS.some((prefix) => hasPrefix(name, prefix)) || ACTIONS.some(([prefix]) => hasPrefix(name, prefix));
}

export function matchAction(uses: string, inputs: Inputs): Finding[] {
  const name = actionName(uses);
  const findings: Finding[] = [];
  for (const [prefix, match] of ACTIONS) {
    const finding = hasPrefix(name, prefix) ? match(inputs) : undefined;
    if (finding) findings.push(finding);
  }
  if (Object.values(inputs).some((value) => value.includes("public.ecr.aws"))) findings.push(publish("ecr_public"));
  return findings;
}

function isTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function trivyScansSecrets(scanners: string | undefined): boolean {
  if (scanners === undefined || scanners.trim() === "") return true;
  return scanners.split(",").some((s) => s.trim().toLowerCase() === "secret");
}

// Splits shell-like text into commands, and each command into words without quotes or brackets.
export function commands(text: string): string[][] {
  return text
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n|;|&&|\|\|?|\$\(|`|\)/)
    .map((command) =>
      command
        .split(/[\s([,]+/)
        .map((word) => word.replace(/^[[("'{,]+|[\]"'),}]+$/g, ""))
        .filter((word) => word !== ""),
    )
    .filter((words) => words.length > 0);
}

// The last path segment, without an image tag, digest or `.exe`.
function base(word: string): string {
  const last = word.slice(word.lastIndexOf("/") + 1).toLowerCase();
  return last.replace(/[@:].*$/, "").replace(/\.exe$/, "");
}

const isFlag = (word: string) => word.startsWith("-");

// The first `count` non-flag words after position `i`.
function args(words: string[], i: number, count = 3): string[] {
  return words.slice(i + 1).filter((word) => !isFlag(word)).slice(0, count);
}

function subcommand(words: string[], heads: string[], subs: string[]): boolean {
  return words.some((word, i) => {
    if (!heads.includes(base(word))) return false;
    for (const arg of args(words, i)) {
      if (subs.includes(arg)) return true;
      if (["run", "run-script", "exec", "x", "dlx"].includes(arg)) return false;
    }
    return false;
  });
}

function flagValue(words: string[], flags: string[]): string | undefined {
  for (let i = 0; i < words.length; i++) {
    for (const flag of flags) {
      if (words[i] === flag) return words[i + 1] ?? "";
      if (words[i].startsWith(`${flag}=`)) return words[i].slice(flag.length + 1);
    }
  }
  return undefined;
}

const CONTAINER_TOOLS = ["docker", "podman", "buildah", "nerdctl", "finch"];
const IMAGE_WRITES = ["push", "tag", "build", "buildx", "image", "manifest", "compose"];

const SCANNER_WORDS: [word: string, tool: ToolId][] = [
  ["trufflehog", "trufflehog"],
  ["gitleaks", "gitleaks"],
  ["ggshield", "ggshield"],
  ["snyk", "snyk"],
  ["semgrep", "semgrep"],
  ["checkov", "checkov"],
  ["inspector-sbomgen", "aws_inspector"],
];

// Findings in shell-like text. `context` holds values the commands may refer to, such as `env:`.
export function matchScript(text: string, context: string[] = []): Finding[] {
  const findings: Finding[] = [];
  const add = (finding: Finding) => findings.push(finding);
  for (const words of commands(text)) {
    const bases = words.map(base);
    if (subcommand(words, ["npm", "yarn", "pnpm", "bun"], ["publish"])) add(publish("npm"));
    if (subcommand(words, ["twine"], ["upload"])) add(publish("pypi"));
    if (subcommand(words, ["poetry"], ["publish"])) add(publish("poetry"));
    if (subcommand(words, ["uv"], ["publish"])) add(publish("uv"));
    if (subcommand(words, ["git"], ["add", "commit", "push"])) add(publish("git_commit"));
    if (words.some((word, i) => base(word) === "gh" && args(words, i, 2).join(" ") === "release create")) {
      add(publish("gh_release"));
    }
    const writesImage = words.some(
      (word, i) => CONTAINER_TOOLS.includes(base(word)) && IMAGE_WRITES.includes(args(words, i, 1)[0] ?? ""),
    );
    if (writesImage && [words.join(" "), ...context].some((value) => value.includes("public.ecr.aws"))) {
      add(publish("ecr_public"));
    }
    for (const [word, tool] of SCANNER_WORDS) if (bases.includes(word)) add(scanner(tool));
    if (bases.includes("trivy") && trivyScansSecrets(flagValue(words, ["--scanners", "--security-checks"]))) {
      add(scanner("trivy"));
    }
    if (subcommand(words, ["docker"], ["scout"]) && words.some((w) => w === "--secrets" || w === "--secrets=true")) {
      add(scanner("docker_scout"));
    }
  }
  return findings;
}
