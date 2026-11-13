import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { check, WORKFLOW, type Files } from "./helpers/workspace.ts";

const S = "zqsentinel";
const s = (text = "") => `${S}${text}`;

type Schema = Record<string, unknown>;
const spec = parse(readFileSync(new URL("../openapi/action-v1.yaml", import.meta.url), "utf8")) as {
  components: { schemas: Record<string, Schema> };
};
const ajv = new Ajv2020({ strict: true, discriminator: true });
for (const [name, schema] of Object.entries(spec.components.schemas)) {
  ajv.addSchema(JSON.parse(JSON.stringify(schema).replaceAll("#/components/schemas/", "")) as Schema, name);
}
const validatePipeline = ajv.getSchema("Pipeline")!;

// Every key and value carries the sentinel, and the steps reach every kind of file the check reads.
const called = `.github/workflows/${s()}.yml`;
const files: Files = {
  [WORKFLOW]: {
    name: s(),
    on: { push: { branches: [s()] } },
    env: { [s("A")]: s() },
    defaults: { run: { "working-directory": s("dir") } },
    jobs: {
      [s("before")]: { steps: [{ run: `echo ${s()}` }] },
      build: {
        name: s(),
        "runs-on": s(),
        env: { [s("B")]: s() },
        steps: [
          { id: s("id"), name: s(), uses: "attacktrap/action@v1", with: { [s()]: s() } },
          { name: s(), if: s(), run: `echo ${s()}\n./${s("a.sh")} ${s()}`, env: { [s("C")]: s() } },
          { run: `make ${s("target")}` },
          { run: `npm run ${s("script")}`, "working-directory": "." },
          { uses: `./${s("action")}`, with: { [s()]: s() } },
          { uses: `x/${s()}@${s()}`, with: { [s()]: s() } },
          { run: `trivy fs ${s()}`, "working-directory": "." },
        ],
      },
      [s("after")]: { needs: ["build"], "runs-on": s(), steps: [{ run: `gh release create ${s()}` }] },
      [s("call")]: { needs: s("after"), uses: `./${called}`, with: { [s()]: s() }, secrets: s() },
    },
  },
  [called]: { on: { workflow_call: { inputs: { [s()]: { type: "string" } } } }, jobs: { [s()]: { steps: [{ run: `gitleaks dir ${s()}` }] } } },
  [`${s("dir")}/${s("a.sh")}`]: `#!/bin/sh\n# ${s()}\ngit push ${s()}\n`,
  [`${s("dir")}/Makefile`]: `${s("target")}:\n\techo ${s()}\n\tnpm publish ${s()}\n`,
  "package.json": { name: s(), scripts: { [s("script")]: `semgrep ci ${s()}` } },
  [`${s("action")}/action.yml`]: {
    name: s(),
    runs: { using: "composite", steps: [{ run: `checkov -d ${s()}`, shell: "bash" }, { uses: `y/${s()}@v1` }] },
  },
};

describe("workflow content never reaches the request body", () => {
  const printed: string[] = [];
  beforeEach(() => {
    const capture = (chunk: unknown) => {
      printed.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, "write").mockImplementation(capture);
    vi.spyOn(process.stderr, "write").mockImplementation(capture);
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => void printed.push(args.join(" ")));
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    printed.length = 0;
  });

  const variants: [string, Files, object][] = [
    ["a full walk", files, { action: s("id") }],
    ["a step that can't be found", files, { action: s("missing"), job: s("missing") }],
    ["a workflow that can't be parsed", { [WORKFLOW]: `${s()}: [\n  ${s()}` }, {}],
    ["a called workflow", files, { job: s(), jobWorkflowRef: `o/r/${called}@${s()}` }],
  ];

  it.each(variants)("%s", (_, workspaceFiles, overrides) => {
    const pipeline = check(workspaceFiles, overrides);
    const body = JSON.stringify({ action_version: "0.0.0", pipeline });
    expect(body).not.toContain(S);
    expect(validatePipeline(pipeline), JSON.stringify(validatePipeline.errors)).toBe(true);
    expect(printed.join("")).not.toContain(S);
  });

  it("the full walk reads every kind of file", () => {
    expect(check(files, { action: s("id") })).toEqual({
      findings: [
        { kind: "public_publish", tool: "git_commit" },
        { kind: "public_publish", tool: "npm" },
        { kind: "scanner", tool: "semgrep" },
        { kind: "scanner", tool: "checkov" },
        { kind: "scanner", tool: "trivy" },
        { kind: "public_publish", tool: "gh_release" },
        { kind: "scanner", tool: "gitleaks" },
      ],
      incomplete: true,
    });
  });
});
