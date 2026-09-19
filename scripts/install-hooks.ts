import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import path from "node:path";

const HOOKS_DIR = ".githooks";

const git = (...args: string[]): string => execFileSync("git", args, { encoding: "utf8" }).trim();

/** Point this repository's git hooks at `.githooks/` (opt-in, per clone). */
const main = (): void => {
  // `core.hooksPath` is relative to the repository root. Inside a monorepo this would replace
  // the root's hooks (husky, lefthook) with a folder that does not exist there.
  if (git("rev-parse", "--show-prefix") !== "") {
    throw new Error(
      `This project is not the root of its git repository. Call ${HOOKS_DIR}/pre-commit from the root's hooks instead.`,
    );
  }
  chmodSync(path.join(HOOKS_DIR, "pre-commit"), 0o755);
  git("config", "core.hooksPath", HOOKS_DIR);
  console.log(`Git hooks enabled from ${HOOKS_DIR}/ (undo: git config --unset core.hooksPath)`);
};

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
