# Security

## Reporting a vulnerability

Use **Report a vulnerability** on the repository's [Security tab](https://github.com/fmchisti/fastra/security)
when that button is shown. Otherwise open an issue that only says you have a security report, without
the details, and a maintainer will arrange a private channel.

## Advisory 2026-11: malicious build script on `main` (11–12 November 2026)

### Summary

On 11 and 12 November 2026 an attacker used stolen maintainer credentials to push a credential-stealing
script to the `main` branch of this repository five times. Each time the attacker removed it again after
4 to 15 minutes. `main` has been clean since 2026-11-12 16:43 UTC, and its contents are identical to the
last legitimate commit (`e6c3258`).

Each push added a hidden file `.ci-<six characters>.sh` to the repository root and changed the `build`
script in `package.json` to run it silently before compiling:

```json
"build": "sh ./.ci-xxxxxx.sh >/dev/null 2>&1; _r=$?; if [ \"$_r\" -eq 42 ]; then exit 42; fi; tsc -p tsconfig.build.json"
```

### Who is affected

`pnpm create fastra` (and `giget`, "Use this template", `git clone`, `git pull`) copies `main` as it is at
that moment. You are affected if you created or updated a project from this repository during one of
these windows (UTC):

| Date | From | To |
|---|---|---|
| 2026-11-11 | 12:20 | 12:36 |
| 2026-11-12 | 07:45 | 07:50 |
| 2026-11-12 | 09:26 | 09:31 |
| 2026-11-12 | 15:07 | 15:12 |
| 2026-11-12 | 16:38 | 16:43 |

Creating the project does not run the script. It runs the first time `pnpm build` runs: on your machine,
in CI, in `docker build`, or in a deploy that builds the project (Railway, Render, Fly, and so on).

The `create-fastra` package on npm was not modified. No version was published during or after the
incident (the latest is 0.1.7, published 2026-09-20). It is still affected indirectly, because it
downloads the template from `main` when you run it.

### How to check your project

Run these in the project folder. Any output means the project is affected.

```bash
ls -a | grep -E '^\.ci-[a-z0-9]+\.sh$'
grep -n '\.ci-' package.json
git log --all --oneline -- '.ci-*.sh'
```

### If you are affected

1. Delete the `.ci-*.sh` file and set `build` back to `tsc -p tsconfig.build.json`. Commit that.
2. If `pnpm build` never ran with the file present (not locally, not in CI, not in a Docker build or
   deploy), you are done.
3. If it did run, treat every secret that machine or job could read as stolen, and rotate it:
   - environment variables and `.env` files (database URLs, API keys, auth secrets)
   - GitHub tokens, Actions secrets, and OIDC-based cloud access of that repository
   - AWS, Google Cloud, and Azure credentials (CLI credential files and environment variables)
   - npm tokens, SSH keys, and credentials stored by AI coding tools
4. Look for things the script tries to leave behind:
   - AWS: access keys you did not create, role trust policies that changed, sessions named `wfx-<number>`
   - Azure: federated identity credentials named `wfx-ci-<number>`
   - GitHub Actions: caches whose key starts with `wfx-`, artifacts named `wfx-loot-<number>`, and
     commit statuses with the description `wfx`. Delete them: they can contain the stolen data.

### What the script does

It collects secrets from the environment, the GitHub Actions runner (including its memory), cloud
credential stores, and the home directory, tries to exchange them for longer-lived cloud access, and
sends the result to Telegram.

### Status

- `main` and every open branch were checked on 2026-11-21: no `.ci-*.sh` file, no changed `build` script,
  no changed workflow, and no `wfx-` caches or artifacts in this repository.
- The pull request the attacker opened (#37, branch `wfx-docs`) was closed and its branch deleted.
- The malicious commits stay in the history of `main` as evidence. They are harmless there: the last
  commit of each group removes the file and restores `package.json`.
- Planned: `create-fastra` should download a tagged release instead of `main`, so that a push to `main`
  cannot reach new projects.
