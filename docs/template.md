# Maintaining Fastra

This file is for changes to Fastra, the template itself. `pnpm setup:project` deletes it (with `setup/` and `test/setup/`) from generated projects.

## How setup works

`setup/cli.ts` asks for one option per feature in `setup/features.ts` (auth, orm, storage, redis, deploy), then:

1. **Checks constraints**: an option's `requires` limits other features (Better Auth requires a database; file storage requires auth). The CLI only offers compatible options.
2. **Deletes paths** owned by unselected options (`paths` in the manifest) and by `CONDITIONAL` entries whose `keepWhen` does not match.
   - A path listed by several options of the same feature is kept if any of them is selected.
   - A path listed by several features is kept only if every feature keeps it (e.g. `src/auth/providers/better-auth/database/prisma.ts` needs Better Auth and Prisma).
   - `CONDITIONAL` covers combinations, e.g. the `todos` example with `keepWhen: "auth!=none&orm!=none"`, and removes their scripts and dependencies too.
3. **Resolves directives** in `.ts`, `.mts`, `.prisma`, `.md`, `.mdc`, `.yml`, and `Dockerfile` files, and removes the directive comments.
4. **Rewrites `package.json`**: removes dependencies and scripts owned only by unselected options, sets the selected options' scripts, and removes the setup tool.
5. **Generates `.env.example`** from `CORE_ENV` plus the selected options' `env`.
6. Runs `pnpm install`, regenerates the initial migration for the selected schema, creates the public `notes` example when there is a database but no auth, formats with Biome, and type-checks.
7. Creates `.env` from the new `.env.example` with generated secrets (`scripts/init-env.ts`), unless one exists.

## Directives

| Form | Use for | Example |
|---|---|---|
| Trailing `// @setup-select <feature>` | Import/export whose path names the selected option | `export { createAuthProvider } from "./providers/better-auth/index.ts"; // @setup-select auth` |
| Trailing `// @setup-if <condition>` | Keep one complete one-line `import`/`export` | `import todoRoutes from "./modules/todos/routes.ts"; // @setup-if auth!=none&orm!=none` |
| Block `// @setup-if <condition>` … `// @setup-endif` | Anything else (object properties, route registration, docs sections) | see `src/container.ts` |
| Block `@setup-template-only` … `@setup-endif` | Text that only makes sense before setup | see `README.md` |

- **Conditions:** clauses `feature=a,b` (one of) or `feature!=a,b` (none of), joined with `&` (and) and `|` (or; `&` binds tighter), no spaces. Examples: `storage=s3,local`, `auth!=none&orm!=none`, `orm!=none|redis=redis`.
- Blocks can be nested: a line is kept only if every enclosing block matches. They also work as `# …` (YAML, Dockerfile) and `<!-- … -->` (Markdown).
- **Every combination must compile in the template**, where all blocks are kept. Never put two variants that conflict (the same property or variable declared twice) in separate blocks; nest blocks instead.
- **Imports must use the trailing forms.** Biome's organize-imports moves standalone comment lines with the import below them, which breaks block directives around imports.
- In Markdown tables, avoid block directives between rows (they break table rendering in the template); use lists instead.
- `@gen:` markers are not setup directives. They stay in generated projects with a database for `pnpm gen:module` (wrapped in `@setup-if orm!=none`).
- When a feature is `none`, code can become unused (an empty interface, an unused parameter). Add the Biome suppression as `// @setup-emit // biome-ignore …` inside a block for exactly that combination (see `src/container.ts`): it stays inert in the template, where a real suppression would be reported as unused, and becomes active in the generated project.

## Template state

The template compiles and runs with every option present at once: `@setup-select` lines point at a default (Better Auth, Drizzle, local storage), and every `@setup-if` block is kept. All provider code is type-checked and tested in the template.

## Adding an option (e.g. Clerk auth, GCS storage, a Kysely ORM)

1. Implement the interface under `src/<area>/providers/<id>/` with the same factory name as the other options (`createAuthProvider`, `createStorage`, `createDatabase`). Validate env inside with `loadEnv`. Accept injected clients for tests.
2. Add tests next to the others (`test/providers/<id>.test.ts`, …) using injected fakes, no network.
3. Add the option to `setup/features.ts`: `paths`, `dependencies`, `devDependencies`, `scripts`, `env`, `nextSteps`, `allowBuilds` for dependencies with install scripts, and `requires` if it only works with some options of another feature. Install dependencies in the template's `package.json`.
4. Add `@setup-if` blocks where the option changes shared files (Dockerfile, CI env, docs).
5. Run `pnpm setup:choices` (so `pnpm create fastra` asks about it). If `allowBuilds` changed, update `pnpm-workspace.yaml` to match (`test/setup/engine.test.ts` checks it). Then run `pnpm setup:verify --only <id>`, then the full matrix.

Adding a whole feature (a new question): add it to `features`, the CLI flags in `setup/cli.ts`, the matrix in `setup/verify.ts`, and `test/setup/engine.test.ts` if the engine changes.

## Verifying

```bash
pnpm setup:verify                 # every valid auth × database × storage × Redis combination
pnpm setup:verify --only prisma   # combinations whose name contains "prisma"
pnpm setup:verify --no-tests      # skip vitest
```

Each combination is applied to a temporary copy (sharing `node_modules`). Then it regenerates migrations, formats, generates a module with every field type, and runs `tsc`, `biome check --error-on-warnings`, and `vitest`. Failing copies are kept, and their paths are printed.

CI runs the matrix (`setup-matrix` job) and a Docker smoke test for a Drizzle and a Prisma + Redis project (`docker` job) on every pull request.

## Install scripts (`allowBuilds`)

pnpm only runs dependency install scripts listed in `allowBuilds` in `pnpm-workspace.yaml` (`true` runs, `false` skips). pnpm 11 fails the install on unlisted ones and no longer reads the `pnpm` field in `package.json`. pnpm 10.28 is the first release that reads `allowBuilds`.

- Each option lists its own in `setup/features.ts` (`allowBuilds`), and `CORE_ALLOW_BUILDS` covers dependencies every project has.
- The template's `pnpm-workspace.yaml` lists every option's entries. Setup rewrites it with only the selected ones.
- A dependency update that adds a package with an install script fails pnpm 11 installs until it is listed. The `monorepo` CI job runs pnpm 11 and catches this.

## `create-fastra` package

`packages/create-fastra/` is the `pnpm create fastra` CLI. It downloads the template with giget (skipping `packages/`, `node_modules`, `.env`, …), then asks the project name and every choice **before installing anything**, using `setup/choices.json` (the questions and `requires` rules from `setup/features.ts` as plain JSON). After the user confirms it runs `pnpm install` and `pnpm setup:project --name … --auth … --yes` (forwarding any other options), then creates a git repository with an initial commit. Cancelling removes the downloaded files. Setup removes `packages/` from generated projects.

After changing `setup/features.ts`, run `pnpm setup:choices` to rewrite `setup/choices.json`; `test/setup/choices.test.ts` fails if it is stale or if the CLI's option filtering disagrees with the setup engine. Templates without `choices.json` fall back to letting setup ask after install.

**Monorepo mode.** When a parent folder has a `pnpm-workspace.yaml`, the CLI:
1. Checks that the target is listed under `packages`. If not, it fails before downloading and suggests a listed folder.
2. After confirmation, deletes the project's `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and `packageManager`, and adds the whole template's `allowBuilds` to the root. The first install still contains every provider, and pnpm 11 fails on unapproved install scripts (it also writes placeholder entries into the root file).
3. Passes `--force` to setup: inside a repository, the new folder always counts as an uncommitted change.
4. After setup, removes the root `allowBuilds` entries it added that the chosen options do not need.
5. With a root `turbo.json`, writes a package `turbo.json` (`outputs: ["dist/**"]`) and a `check-types` script.

Inside any existing git repository (monorepo or not) it skips `git init` and deletes the project's `.github/`.

- Code: `src/cli.ts` (argument parsing, target checks, template fetching), `src/monorepo.ts` (workspace detection and root file edits), and `src/index.ts` (the interactive flow). Tests: `packages/create-fastra/test/`, run by the root `pnpm test`.
- `--template` accepts a giget source (`gh:fmchisti/fastra#v1.0.0`) or a local folder, which CI uses to test the current commit.
- CI job `create-fastra` builds and packs the package like `npm publish`, creates a project from the checkout with `pnpm dlx`, and checks it (name, no setup files, clean git tree, check/type-check/test).
- CI job `monorepo` does the same inside a fresh Turborepo on pnpm 10.28 and pnpm 11. It checks the root files, then runs `turbo run build lint check-types test` and a cached rebuild. It installs without the template's lockfile, so newer dependency versions are tested too.
- CI job `latest-dependencies` type-checks and tests the template with the newest versions its ranges allow, which is what a monorepo installs.

### Publishing

Publishing needs an npm account with 2FA (npm asks for the authenticator code):

```bash
pnpm install
pnpm build:create
npm login
(cd packages/create-fastra && npm publish --access public)
```

Then anyone can run `pnpm create fastra my-api` (or `npm create fastra@latest my-api`).

For a new CLI release, bump `version` in `packages/create-fastra/package.json`, build, and publish it. The CLI downloads the template from `main` at run time, so template changes need no new package version.

## Checklist for template changes

- [ ] `pnpm verify`
- [ ] `pnpm setup:verify` passes for every combination
- [ ] New env vars in `CORE_ENV` or the option's `env`
- [ ] New dependencies with install scripts in `allowBuilds` (manifest and `pnpm-workspace.yaml`)
- [ ] Docs use directives so generated projects only describe what they contain
- [ ] `AGENTS.md` updated if conventions changed
