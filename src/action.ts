import { getToken, reportPlacement, requestCanary, serverAt, type Server } from "./api.ts";
import { checkPipeline } from "./pipeline/check.ts";
import { runnerEnv } from "./pipeline/env.ts";
import { collectProject } from "./project.ts";
import { say, type Outcome } from "./warnings.ts";
import { findCheckout, writeInside } from "./workspace.ts";

// main() calls this with no argument, so production always talks to serverAt()'s defaults.
export async function action(server: Server = serverAt()): Promise<void> {
  say(await run(server));
}

// Each step returns what the next one needs or the Outcome that ends the run, so nothing here prints.
async function run(server: Server): Promise<Outcome> {
  const token = await getToken(server);
  if (token === undefined) return "no_token";
  const checkout = await findCheckout(process.env.GITHUB_WORKSPACE);
  if (typeof checkout === "string") return checkout;
  const pipeline = checkPipeline(runnerEnv(process.env, token));
  const project = await collectProject(checkout.root);
  const place = await requestCanary(server, token, { pipeline, project });
  if (typeof place === "string") return place;
  const status = await writeInside(checkout, place.path, place.content);
  await reportPlacement(server, place, status);
  return status;
}
