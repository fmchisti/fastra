// Runs on `npm publish` (prepublishOnly). Builds the CLI and pins it to the commit being published.
// Refuses to publish from a state that is not exactly what is on GitHub's main branch.
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const packageDir = path.resolve(import.meta.dirname, "..");
const git = (...args) => execFileSync("git", args, { cwd: packageDir, encoding: "utf8" }).trim();
const fail = (message) => {
  console.error(`\nNot published: ${message}\n`);
  process.exit(1);
};

if (git("status", "--porcelain") !== "") fail("the working tree has uncommitted changes.");
git("fetch", "--quiet", "origin", "main");
const head = git("rev-parse", "HEAD");
if (head !== git("rev-parse", "origin/main")) {
  fail("HEAD is not origin/main. Publish from an up-to-date main, so the pinned commit exists on GitHub.");
}
if (!/^[0-9a-f]{40}$/.test(head)) fail(`unexpected commit id "${head}".`);

// A fresh build from this commit: nothing left over from an earlier one
rmSync(path.join(packageDir, "dist"), { recursive: true, force: true });
execFileSync("pnpm", ["build:create"], { cwd: path.resolve(packageDir, "../.."), stdio: "inherit" });
writeFileSync(
  path.join(packageDir, "dist", "template-ref.js"),
  `// Written by scripts/pin-template.mjs when this version was published\nexport const TEMPLATE_COMMIT = "${head}";\n`,
);
console.log(`create-fastra: template pinned to ${head}`);
