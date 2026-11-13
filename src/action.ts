import * as core from "@actions/core";
import { API_BASE_URL } from "./api.ts";

export async function action(): Promise<void> {
  core.debug(`API base URL: ${API_BASE_URL}`);
}
