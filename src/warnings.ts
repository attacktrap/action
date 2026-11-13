import * as core from "@actions/core";

const PLACED = "AttackTrap: canary placed. Details are in your dashboard.";

export const SKIPS = {
  not_onboarded: "This repository's owner has no account, so no canary was placed. Sign up free at https://app.attacktrap.com/.",
  cap_reached: "This account has reached its limit, so no canary was placed. See your dashboard.",
  unsupported_event: "This workflow event isn't supported, so no canary was placed.",
  unsupported_project: "This project type isn't supported yet, so no canary was placed.",
  pipeline_public_publish: "A later step publishes publicly, so no canary was placed. See the README, or override in your dashboard.",
  pipeline_scanner: "A scanner runs after this step, so no canary was placed. See the README, or override in your dashboard.",
  pipeline_unreadable: "The workflow couldn't be read, so no canary was placed. See the README, or override in your dashboard.",
  temporarily_unavailable: "The service is temporarily unavailable, so no canary was placed.",
} as const satisfies Record<string, string>;

const WARNINGS = {
  internal_error: "The action hit an unexpected error and stopped.",
  timed_out: "The action ran past its time budget and stopped.",
  no_token: "The job has no OIDC token, so no canary was placed. Give the job `id-token: write` permission.",
  no_checkout: "There is no checkout in the workspace, so no canary was placed. Run actions/checkout before this step.",
  server_unreachable:
    "The AttackTrap server couldn't be reached or sent an answer this version doesn't understand, so no canary was placed.",
  path_exists: "A file already exists where the canary would go, so no canary was placed.",
  write_failed: "The file couldn't be written, so no canary was placed.",
  ...SKIPS,
} as const satisfies Record<string, string>;

export type SkipCode = keyof typeof SKIPS;
export type WarningCode = keyof typeof WARNINGS;

/** How a run ends. `internal_error` and `timed_out` belong to the supervisor in main.ts. */
export type Outcome = "written" | Exclude<WarningCode, "internal_error" | "timed_out">;

export function warn(code: WarningCode): void {
  try {
    core.warning(`AttackTrap [${code}]: ${WARNINGS[code]} Your build is unaffected.`);
  } catch {}
}

/** Prints the run's one line. */
export function say(outcome: Outcome): void {
  if (outcome !== "written") return warn(outcome);
  try {
    core.info(PLACED);
  } catch {}
}
