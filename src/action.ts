import * as core from "@actions/core";

export async function action(): Promise<void> {
  core.debug(`API base URL: ${API_BASE_URL}`);
}
