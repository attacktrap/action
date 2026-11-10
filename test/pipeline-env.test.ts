import { describe, expect, it } from "vitest";
import { runnerEnv } from "../src/pipeline/env.ts";

const token = (payload: object) => `a.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.b`;
const vars = { GITHUB_WORKSPACE: "/w", GITHUB_REPOSITORY: "o/r", GITHUB_WORKFLOW_REF: "o/r/a.yml@v1", GITHUB_JOB: "j", GITHUB_ACTION: "s" };

describe("runnerEnv", () => {
  it("reads the runner variables and the called workflow from the token", () => {
    expect(runnerEnv(vars, token({ job_workflow_ref: "o/r/b.yml@v1" }))).toEqual({
      workspace: "/w",
      repository: "o/r",
      workflowRef: "o/r/a.yml@v1",
      jobWorkflowRef: "o/r/b.yml@v1",
      job: "j",
      action: "s",
    });
  });

  it.each([["no token", undefined], ["a malformed token", "a.b"], ["no claim", token({})], ["a non-string claim", token({ job_workflow_ref: 1 })]])(
    "has no called workflow with %s",
    (_, idToken) => {
      expect(runnerEnv(vars, idToken).jobWorkflowRef).toBeUndefined();
    },
  );
});
