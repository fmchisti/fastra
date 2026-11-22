/**
 * Commit of the template this build of the CLI creates projects from.
 *
 * `null` here: an unpublished build uses the `main` branch. `npm publish` replaces the compiled
 * copy of this file with the commit it publishes from (`scripts/pin-template.mjs`), so a published
 * version always creates projects from one known commit. Someone who can push to the repository
 * cannot change what `pnpm create fastra` installs without also publishing a new npm version.
 */
export const TEMPLATE_COMMIT: string | null = null;
