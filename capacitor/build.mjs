// Builds dist/ for npm (`npm pack` / `npm publish` run it through prepack).
// The source imports "./index" without an extension (the tests resolve it like a bundler); in the published ES
// modules it becomes "./index.js", so webpack / Re.Pack and Node resolve it too.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const dist = join(here, "dist");
rmSync(dist, { recursive: true, force: true });
execFileSync("npx", ["--no-install", "tsc", "-p", join(here, "tsconfig.build.json")], { stdio: "inherit", cwd: here });
for (const f of readdirSync(dist).filter((f) => f.endsWith(".js") || f.endsWith(".d.ts"))) {
  const file = join(dist, f);
  const src = readFileSync(file, "utf8");
  const out = src.replace(/(from\s+["'])(\.{1,2}\/[^"']+?)(["'])/g, (m, a, spec, b) => (/\.[a-z]+$/i.test(spec) ? m : `${a}${spec}.js${b}`));
  if (out !== src) writeFileSync(file, out);
}
