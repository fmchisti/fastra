# create-fastra

Create a type-safe Fastify + TypeScript API from [Fastra](https://github.com/fmchisti/fastra).

```bash
pnpm create fastra shop-api
```

It downloads the template (a few seconds), asks for the project name and your choices (auth, database, storage, Redis, and deploy target, each optional), and only after you confirm installs dependencies, builds the project from your answers (everything you did not choose is deleted), and creates a git repository with an initial commit. Cancel at any question and the downloaded files are removed.

Non-interactive:

```bash
pnpm create fastra shop-api --auth logto --orm prisma --storage s3 --redis redis --deploy railway --yes
```

An API with no database and no auth (for example a gateway to other services):

```bash
pnpm create fastra gateway --auth none --orm none --storage none --redis none --deploy none --yes
```

**Inside a monorepo** (Turborepo or any pnpm workspace), run it from the root with a folder the workspace lists:

```bash
pnpm create fastra apps/api
```

The API then uses the workspace's lockfile and pnpm version. Install-script approvals it needs go into `allowBuilds` in the root `pnpm-workspace.yaml`. No nested git repository or `.github/` is created. With Turborepo it also adds `apps/api/turbo.json` (cached `dist/`) and a `check-types` script. The Dockerfile builds from the monorepo root: `docker build -f apps/api/Dockerfile -t api .`. Needs pnpm 10.28+.

| Option | Values |
|---|---|
| `--name` | package name (default: directory name) |
| `--auth` | `better-auth` (needs a database) · `supabase` · `firebase` · `logto` · `none` |
| `--orm` | `drizzle` · `prisma` · `none` |
| `--storage` | `s3` · `local` · `none` (uploads need auth) |
| `--redis` | `none` · `redis` |
| `--deploy` | `railway` · `none` |
| `--yes` | use defaults for anything not passed |
| `--template <source>` | another branch or tag (`gh:fmchisti/fastra#v1.0.0`), a fork, or a local folder |
| `--no-git` | skip `git init` and the initial commit (always skipped inside an existing git repository) |

Requires Node.js 22.12+ and pnpm (`corepack enable`).

## License

MIT © Fahim Mahmud Chisti
