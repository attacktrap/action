import { describe, expect, it } from "vitest";
import type { Finding } from "../src/pipeline/check.ts";
import { check, steps, THIS_STEP, WORKFLOW } from "./helpers/workspace.ts";

const publish = (tool: Finding["tool"]): Finding => ({ kind: "public_publish", tool });
const scanner = (tool: Finding["tool"]): Finding => ({ kind: "scanner", tool });
const UNREADABLE = { findings: [{ kind: "unreadable", tool: "unknown" }], incomplete: false };
const CLEAN = { findings: [], incomplete: false };

const run = (script: string) => ({ run: script });
const uses = (action: string, inputs?: object) => ({ uses: action, ...(inputs ? { with: inputs } : {}) });

describe("rules", () => {
  const cases: [string, object, Finding | undefined][] = [
    ["npm publish", run("npm publish --access public"), publish("npm")],
    ["yarn npm publish", run("yarn npm publish"), publish("npm")],
    ["pnpm publish", run("pnpm publish --no-git-checks"), publish("npm")],
    ["npm-publish action", uses("JS-DevTools/npm-publish@v4", { token: "t" }), publish("npm")],
    ["twine upload", run("python -m twine upload dist/*"), publish("pypi")],
    ["pypi publish action", uses("pypa/gh-action-pypi-publish@release/v1"), publish("pypi")],
    ["poetry publish", run("poetry publish --build"), publish("poetry")],
    ["uv publish", run("uv publish"), publish("uv")],
    ["public ECR tag", run("docker build -t public.ecr.aws/a/b:1 .\ndocker push public.ecr.aws/a/b:1"), publish("ecr_public")],
    ["public ECR tag in env", { run: "docker push $IMAGE", env: { IMAGE: "public.ecr.aws/a/b" } }, publish("ecr_public")],
    ["public ECR tag in action", uses("docker/build-push-action@v7", { push: true, tags: "public.ecr.aws/a/b:1" }), publish("ecr_public")],
    ["gh release create", run("gh release create v1 a/b.txt"), publish("gh_release")],
    ["release action", uses("softprops/action-gh-release@v3"), publish("gh_release")],
    ["artifact upload", uses("actions/upload-artifact@v4", { path: "a" }), publish("gh_artifact")],
    ["pages deploy", uses("actions/deploy-pages@v4"), publish("gh_pages")],
    ["pages artifact", uses("actions/upload-pages-artifact@v3"), publish("gh_pages")],
    ["pages action", uses("peaceiris/actions-gh-pages@v4"), publish("gh_pages")],
    ["git add", run("git add -A"), publish("git_commit")],
    ["git commit", run('git -C a commit -m "content"'), publish("git_commit")],
    ["git push", run("git push origin HEAD"), publish("git_commit")],
    ["auto-commit action", uses("stefanzweifel/git-auto-commit-action@v5"), publish("git_commit")],
    ["add-and-commit action", uses("EndBug/add-and-commit@v9"), publish("git_commit")],
    ["trufflehog action", uses("trufflesecurity/trufflehog@main"), scanner("trufflehog")],
    ["trufflehog command", run("trufflehog filesystem ."), scanner("trufflehog")],
    ["trufflehog image", run("docker run --rm trufflesecurity/trufflehog:latest git file://."), scanner("trufflehog")],
    ["gitleaks action", uses("gitleaks/gitleaks-action@v3"), scanner("gitleaks")],
    ["gitleaks command", run("gitleaks dir ."), scanner("gitleaks")],
    ["ggshield action", uses("GitGuardian/ggshield-action@v1"), scanner("ggshield")],
    ["ggshield command", run("ggshield secret scan path -r ."), scanner("ggshield")],
    ["trivy action", uses("aquasecurity/trivy-action@v0.36.0", { "image-ref": "a" }), scanner("trivy")],
    ["trivy action with secret scanner", uses("aquasecurity/trivy-action@v0.36.0", { scanners: "vuln,secret" }), scanner("trivy")],
    ["trivy command", run("trivy fs --exit-code 1 ."), scanner("trivy")],
    ["trivy command with secret scanner", run("trivy image --scanners=secret a"), scanner("trivy")],
    ["snyk action", uses("snyk/actions/node@master"), scanner("snyk")],
    ["snyk command", run("npx snyk test"), scanner("snyk")],
    ["semgrep action", uses("semgrep/semgrep-action@v1"), scanner("semgrep")],
    ["semgrep command", run("semgrep ci"), scanner("semgrep")],
    ["checkov action", uses("bridgecrewio/checkov-action@v12"), scanner("checkov")],
    ["checkov command", run("checkov -d ."), scanner("checkov")],
    ["scout action with secrets", uses("docker/scout-action@v1", { command: "sbom", secrets: true }), scanner("docker_scout")],
    ["scout command with secrets", run("docker scout sbom --secrets a"), scanner("docker_scout")],
    ["inspector action", uses("aws-actions/vulnerability-scan-github-action-for-amazon-inspector@v1"), scanner("aws_inspector")],
    ["inspector command", run("./inspector-sbomgen container --image a"), scanner("aws_inspector")],
    ["docker action image", uses("docker://aquasec/trivy:latest", { args: "fs ." }), scanner("trivy")],
    ["grype", run("grype dir:."), undefined],
    ["grype action", uses("anchore/scan-action@v7"), undefined],
    ["trivy without secret scanner", run("trivy fs --scanners vuln,misconfig ."), undefined],
    ["trivy action without secret scanner", uses("aquasecurity/trivy-action@v0.36.0", { scanners: "vuln" }), undefined],
    ["scout without secrets", uses("docker/scout-action@v1", { command: "cves" }), undefined],
    ["scout command without secrets", run("docker scout cves a"), undefined],
    ["Docker Hub push", run("docker push a/b:1"), undefined],
    ["GHCR push", run("docker push ghcr.io/a/b:1"), undefined],
    ["private ECR push", run("docker push 0.dkr.ecr.us-east-1.amazonaws.com/b:1"), undefined],
    ["public ECR pull", run("docker pull public.ecr.aws/a/b:1"), undefined],
    ["npm run of a missing script named publish", run("npm run publish --if-present"), undefined],
    ["git read", run("git log -1"), undefined],
  ];

  it.each(cases)("%s", (_, step, finding) => {
    expect(check(steps(step)).findings).toEqual(finding ? [finding] : []);
  });

  it("counts conditional steps", () => {
    expect(check(steps({ if: "false", run: "gitleaks dir ." })).findings).toEqual([scanner("gitleaks")]);
  });

  it("reports each finding once, in order", () => {
    const result = check(steps(run("trivy fs .\ntrivy image a"), run("npm publish"), run("trivy fs .")));
    expect(result).toEqual({ findings: [scanner("trivy"), publish("npm")], incomplete: false });
  });
});

describe("later steps", () => {
  it("ignores steps before this one", () => {
    const files = { [WORKFLOW]: { jobs: { build: { steps: [run("gitleaks dir ."), THIS_STEP, run("true")] } } } };
    expect(check(files)).toEqual(CLEAN);
  });

  it("finds this step by its id before the first use of the action", () => {
    const files = {
      [WORKFLOW]: {
        jobs: { build: { steps: [THIS_STEP, run("gitleaks dir ."), { id: "second", uses: "attacktrap/action@v1" }] } },
      },
    };
    expect(check(files, { action: "second" })).toEqual(CLEAN);
    expect(check(files, { action: "__attacktrap_action" }).findings).toEqual([scanner("gitleaks")]);
  });

  const jobs = {
    first: { steps: [run("trivy fs .")] },
    build: { needs: "first", steps: [THIS_STEP] },
    parallel: { steps: [run("gitleaks dir .")] },
    next: { needs: ["build"], steps: [run("npm publish")] },
    after: { needs: ["next", "parallel"], steps: [run("semgrep ci")] },
    unrelated: { needs: "parallel", steps: [run("checkov -d .")] },
  };

  it("follows needs chains and ignores parallel and earlier jobs", () => {
    expect(check({ [WORKFLOW]: { jobs } })).toEqual({ findings: [publish("npm"), scanner("semgrep")], incomplete: false });
  });

  it("follows a same-repo reusable workflow called by a later job, one level deep", () => {
    const files = {
      [WORKFLOW]: {
        jobs: {
          build: { steps: [THIS_STEP] },
          deploy: { needs: "build", uses: "./.github/workflows/deploy.yml" },
          release: { needs: "build", uses: "o/r/.github/workflows/release.yml@main" },
        },
      },
      ".github/workflows/deploy.yml": { on: "workflow_call", jobs: { a: { steps: [run("trivy fs .")] } } },
      ".github/workflows/release.yml": { on: "workflow_call", jobs: { a: { steps: [uses("actions/upload-artifact@v4")] } } },
    };
    expect(check(files)).toEqual({ findings: [scanner("trivy"), publish("gh_artifact")], incomplete: false });
  });

  it("is incomplete for a reusable workflow in another repo, a nested call or a missing file", () => {
    const later = (job: object) => ({ [WORKFLOW]: { jobs: { build: { steps: [THIS_STEP] }, later: { needs: "build", ...job } } } });
    expect(check(later({ uses: "x/y/.github/workflows/a.yml@v1" }))).toEqual({ findings: [], incomplete: true });
    expect(check(later({ uses: "./.github/workflows/missing.yml" }))).toEqual({ findings: [], incomplete: true });
    const nested = {
      ...later({ uses: "./.github/workflows/a.yml" }),
      ".github/workflows/a.yml": { jobs: { a: { uses: "./.github/workflows/b.yml" } } },
      ".github/workflows/b.yml": { jobs: { b: { steps: [run("gitleaks dir .")] } } },
    };
    expect(check(nested)).toEqual({ findings: [], incomplete: true });
  });
});

describe("this action inside a reusable workflow", () => {
  const called = ".github/workflows/called.yml";
  const files = {
    [WORKFLOW]: {
      jobs: {
        before: { steps: [run("gitleaks dir .")] },
        call: { needs: "before", uses: `./${called}` },
        after: { needs: "call", steps: [run("npm publish")] },
        parallel: { steps: [run("checkov -d .")] },
      },
    },
    [called]: {
      on: "workflow_call",
      jobs: { build: { steps: [THIS_STEP, run("trivy fs .")] }, other: { steps: [run("semgrep ci")] } },
    },
  };

  it("reads the called file for this job and the caller for the jobs after the calling job", () => {
    const result = check(files, { jobWorkflowRef: `o/r/${called}@refs/heads/main` });
    expect(result).toEqual({ findings: [scanner("trivy"), publish("npm")], incomplete: false });
  });

  it("is unreadable when the called workflow is in another repo", () => {
    expect(check(files, { jobWorkflowRef: "x/y/.github/workflows/called.yml@v1" })).toEqual(UNREADABLE);
  });

  it("is incomplete when no caller job calls it directly", () => {
    const result = check({ ...files, [WORKFLOW]: { jobs: { a: { steps: [] } } } }, { jobWorkflowRef: `o/r/${called}@v1` });
    expect(result).toEqual({ findings: [scanner("trivy")], incomplete: true });
  });
});

describe("one level into the repo", () => {
  it.each([
    ["a Makefile target", { Makefile: "build:\n\techo content\nscan: build\n\t@trivy fs .\n" }, "make scan"],
    ["a Makefile default target", { Makefile: ".PHONY: scan\nscan:\n\ttrivy fs .\n" }, "make -j4"],
    ["a Makefile in another directory", { "a/Makefile": "scan:\n\ttrivy fs .\n" }, "make -C a scan"],
    ["a package script", { "package.json": { scripts: { scan: "trivy fs ." } } }, "npm run scan"],
    ["an npm shortcut", { "package.json": { scripts: { test: "trivy fs ." } } }, "npm test"],
    ["an npm pre script", { "package.json": { scripts: { pretest: "trivy fs .", test: "true" } } }, "npm t"],
    ["a yarn script", { "package.json": { scripts: { scan: "trivy fs ." } } }, "yarn scan"],
    ["a pnpm script", { "a/package.json": { scripts: { scan: "trivy fs ." } } }, "pnpm -C a run scan"],
    ["a script file", { "a/b.sh": "#!/bin/sh\ntrivy fs .\n" }, "./a/b.sh"],
    ["a script file run by an interpreter", { "a/b.py": 'import subprocess\nsubprocess.run(["trivy", "fs", "."])\n' }, "python3 a/b.py --x"],
    ["a script file under the workspace variable", { "a/b.sh": "trivy fs .\n" }, "bash ${{ github.workspace }}/a/b.sh"],
  ])("follows %s", (_, files, script) => {
    expect(check({ ...steps(run(script)), ...files })).toEqual({ findings: [scanner("trivy")], incomplete: false });
  });

  it("uses the step's working directory", () => {
    const files = { ...steps({ run: "./b.sh", "working-directory": "a" }), "a/b.sh": "gitleaks dir ." };
    expect(check(files).findings).toEqual([scanner("gitleaks")]);
  });

  it("follows a local composite action", () => {
    const files = {
      ...steps(uses("./a")),
      "a/action.yml": {
        runs: { using: "composite", steps: [{ run: "gitleaks dir .", shell: "bash" }, uses("actions/upload-artifact@v4")] },
      },
    };
    expect(check(files)).toEqual({ findings: [scanner("gitleaks"), publish("gh_artifact")], incomplete: false });
  });

  it.each([
    ["a missing script file", {}, run("./a/b.sh")],
    ["a missing package script", { "package.json": { scripts: {} } }, run("npm run scan")],
    ["a missing Makefile target", { Makefile: "a:\n\ttrue\n" }, run("make scan")],
    ["a script name from a variable", { "package.json": { scripts: {} } }, run("npm run $TARGET")],
    ["a target from an expression", {}, run("make ${{ matrix.target }}")],
    ["a command from a variable", {}, run("$TOOL fs .")],
    ["a second level of calls", { "a/b.sh": "./a/c.sh\n", "a/c.sh": "gitleaks dir .\n" }, run("./a/b.sh")],
    ["a remote composite action", {}, uses("x/y@v1")],
    ["an action from an expression", {}, uses("${{ matrix.action }}")],
    ["a missing local action", {}, uses("./a")],
    ["a local action that isn't composite", { "a/action.yml": { runs: { using: "node24", main: "a.js" } } }, uses("./a")],
    ["a local action inside a local action", { "a/action.yml": { runs: { using: "composite", steps: [uses("./b")] } } }, uses("./a")],
    ["a file outside the workspace", {}, run("bash ../a/b.sh")],
  ])("is incomplete for %s", (_, files, step) => {
    expect(check({ ...steps(step), ...files })).toEqual({ findings: [], incomplete: true });
  });

  it("is complete for known actions and a missing script run with --if-present", () => {
    const files = { ...steps(uses("actions/setup-node@v5"), run("npm run scan --if-present")), "package.json": { scripts: {} } };
    expect(check(files)).toEqual(CLEAN);
  });
});

describe("unreadable", () => {
  it.each([
    ["the workflow is missing", {}, {}],
    ["the workflow isn't YAML", { [WORKFLOW]: "jobs: [\n" }, {}],
    ["the workflow has no jobs", { [WORKFLOW]: { on: "push" } }, {}],
    ["this job is missing", steps(), { job: "other" }],
    ["this step is missing", { [WORKFLOW]: { jobs: { build: { steps: [run("true")] } } } }, { action: "other" }],
    ["the workflow is in another repo", steps(), { workflowRef: "x/y/.github/workflows/ci.yml@v1" }],
    ["the workflow path leaves the workspace", steps(), { workflowRef: "o/r/../ci.yml@v1" }],
    ["the runner variables are missing", steps(), { workflowRef: undefined }],
  ])("when %s", (_, files, overrides) => {
    expect(check(files, overrides)).toEqual(UNREADABLE);
  });

  it("when the workspace is missing", () => {
    expect(check(steps(), { workspace: "/nonexistent/a" })).toEqual(UNREADABLE);
  });
});
