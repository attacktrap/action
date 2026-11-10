import type { RunnerEnv } from "./check.ts";

// The runner variables the check needs, plus the called workflow from the OIDC token's payload.
// The token's signature isn't checked: the claim is used only to find a file in the checkout.
export function runnerEnv(vars: Record<string, string | undefined>, idToken: string | undefined): RunnerEnv {
  return {
    workspace: vars.GITHUB_WORKSPACE,
    repository: vars.GITHUB_REPOSITORY,
    workflowRef: vars.GITHUB_WORKFLOW_REF,
    jobWorkflowRef: jobWorkflowRef(idToken),
    job: vars.GITHUB_JOB,
    action: vars.GITHUB_ACTION,
  };
}

function jobWorkflowRef(idToken: string | undefined): string | undefined {
  try {
    const payload: unknown = JSON.parse(Buffer.from(idToken?.split(".")[1] ?? "", "base64url").toString("utf8"));
    const ref = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>).job_workflow_ref : undefined;
    return typeof ref === "string" ? ref : undefined;
  } catch {
    return undefined;
  }
}
