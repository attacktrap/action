import * as core from "@actions/core";

const WARNINGS = {
  internal_error: "The action hit an unexpected error and stopped.",
  timed_out: "The action ran past its time budget and stopped.",
} as const satisfies Record<string, string>;

export type WarningCode = keyof typeof WARNINGS;

export function warn(code: WarningCode): void {
  try {
    core.warning(`Woozle Trap [${code}]: ${WARNINGS[code]} Your build is unaffected.`);
  } catch {}
}
