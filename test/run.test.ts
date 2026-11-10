import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { run } from "../src/run.ts";

let stdout = "";

beforeEach(() => {
  vi.useFakeTimers();
  stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("times out hanging work after the default 30 second budget", async () => {
  let signal: AbortSignal | undefined;
  let settled = false;
  const done = run((s) => {
    signal = s;
    return new Promise(() => {});
  }).then(() => (settled = true));

  await vi.advanceTimersByTimeAsync(29_999);
  expect(settled).toBe(false);
  expect(stdout).not.toContain("::warning::");
  expect(signal?.aborted).toBe(false);

  await vi.advanceTimersByTimeAsync(1);
  await done;
  expect(stdout).toContain("::warning::Woozle Trap [timed_out]: ");
  expect(signal?.aborted).toBe(true);
});

it("leaves no budget timer behind when work finishes", async () => {
  await run(async () => {});
  expect(vi.getTimerCount()).toBe(0);
  expect(stdout).toBe("");
});
