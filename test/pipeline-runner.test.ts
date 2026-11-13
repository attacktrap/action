import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { stepIds } from "../src/pipeline/check.ts";

// Only on GitHub's runner, where GITHUB_ACTION is the id GitHub gave the step running these tests.
it.runIf(process.env.GITHUB_ACTIONS === "true")("matches the id GitHub gives the step running the tests", () => {
  const { GITHUB_WORKSPACE, GITHUB_REPOSITORY, GITHUB_WORKFLOW_REF, GITHUB_JOB, GITHUB_ACTION } = process.env;
  const file = (GITHUB_WORKFLOW_REF ?? "").slice(`${GITHUB_REPOSITORY}/`.length).split("@")[0];
  const steps = parse(readFileSync(path.join(GITHUB_WORKSPACE ?? "", file), "utf8")).jobs[GITHUB_JOB ?? ""].steps;
  const index = stepIds(steps).indexOf(GITHUB_ACTION ?? "");
  console.log(`GITHUB_ACTION is ${GITHUB_ACTION}, step ${index + 1} of ${steps.length}`);
  expect(steps[index]?.run).toMatch(/\btest\b/);
});
