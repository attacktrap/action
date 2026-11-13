import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { checkPipeline, type Pipeline, type RunnerEnv } from "../../src/pipeline/check.ts";

export const WORKFLOW = ".github/workflows/ci.yml";
export const THIS_STEP = { uses: "attacktrap/action@v1" };

export type Files = Record<string, string | object>;

export function workspace(files: Files): string {
  const root = mkdtempSync(path.join(tmpdir(), "pipeline-"));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, ...name.split("/"));
    mkdirSync(path.dirname(file), { recursive: true });
    const text = typeof content === "string" ? content : name.endsWith(".json") ? JSON.stringify(content) : stringify(content);
    writeFileSync(file, text);
  }
  return root;
}

export function env(root: string, overrides: Partial<RunnerEnv> = {}): RunnerEnv {
  return {
    workspace: root,
    repository: "o/r",
    workflowRef: `o/r/${WORKFLOW}@refs/heads/main`,
    jobWorkflowRef: undefined,
    job: "build",
    action: "__attacktrap_action",
    ...overrides,
  };
}

export function check(files: Files, overrides: Partial<RunnerEnv> = {}): Pipeline {
  return checkPipeline(env(workspace(files), overrides));
}

// A workflow whose `build` job runs this action then `later`.
export function steps(...later: object[]): Files {
  return { [WORKFLOW]: { on: "push", jobs: { build: { "runs-on": "ubuntu-latest", steps: [THIS_STEP, ...later] } } } };
}
