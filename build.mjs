import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { define } from "./build.config.mjs";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  legalComments: "none",
  define,
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});

if (process.argv.includes("--check")) {
  const status = execFileSync("git", ["status", "--porcelain", "dist"], { encoding: "utf8" });
  if (status) {
    console.error("dist/ is stale. Run `npm run build` and commit dist/.\n" + status);
    execFileSync("git", ["diff", "--text", "--", "dist"], { stdio: "inherit" });
    process.exit(1);
  }
}
