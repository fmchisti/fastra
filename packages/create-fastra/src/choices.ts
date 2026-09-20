import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** Mirrors `setup/choices.json` in the template (written by `pnpm setup:choices`). */
export interface ChoiceOption {
  value: string;
  label: string;
  hint?: string;
  requires?: Record<string, string[]>;
  allowBuilds?: Record<string, boolean>;
}

export interface ChoiceFeature {
  id: string;
  label: string;
  default: string;
  options: ChoiceOption[];
}

export interface Choices {
  version: 1;
  /** Install-script approvals every project needs; options add their own. */
  allowBuilds: Record<string, boolean>;
  features: ChoiceFeature[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAllowBuilds = (value: unknown): value is Record<string, boolean> =>
  isRecord(value) && Object.values(value).every((allowed) => typeof allowed === "boolean");

const isOption = (value: unknown): value is ChoiceOption =>
  isRecord(value) &&
  typeof value.value === "string" &&
  typeof value.label === "string" &&
  (value.hint === undefined || typeof value.hint === "string") &&
  (value.requires === undefined ||
    (isRecord(value.requires) &&
      Object.values(value.requires).every(
        (list) => Array.isArray(list) && list.every((item) => typeof item === "string"),
      ))) &&
  (value.allowBuilds === undefined || isAllowBuilds(value.allowBuilds));

const isFeature = (value: unknown): value is ChoiceFeature =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.label === "string" &&
  typeof value.default === "string" &&
  Array.isArray(value.options) &&
  value.options.length > 0 &&
  value.options.every(isOption);

/** Reads the template's choices, or `null` for templates that do not ship them. */
export const readChoices = async (templateDir: string): Promise<Choices | null> => {
  const file = path.join(templateDir, "setup", "choices.json");
  if (!existsSync(file)) return null;
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.features)) return null;
  const list: unknown[] = parsed.features;
  if (!list.every(isFeature)) return null;
  // Older templates have no allowBuilds
  const allowBuilds = isAllowBuilds(parsed.allowBuilds) ? parsed.allowBuilds : {};
  return { version: 1, allowBuilds, features: list };
};

/** Same rules as the template's setup engine: options whose `requires` fit the answers so far. */
export const allowedOptions = (
  choices: Choices,
  selection: Record<string, string>,
  featureId: string,
): string[] => {
  const feature = choices.features.find((entry) => entry.id === featureId);
  if (!feature) return [];

  return feature.options
    .filter((option) => {
      for (const [other, allowed] of Object.entries(option.requires ?? {})) {
        const chosen = selection[other];
        if (chosen !== undefined && !allowed.includes(chosen)) return false;
      }
      for (const [other, chosen] of Object.entries(selection)) {
        if (other === featureId) continue;
        const chosenOption = choices.features
          .find((entry) => entry.id === other)
          ?.options.find((entry) => entry.value === chosen);
        const allowed = chosenOption?.requires?.[featureId];
        if (allowed && !allowed.includes(option.value)) return false;
      }
      return true;
    })
    .map((option) => option.value);
};

export interface SetupFlags {
  name: string | undefined;
  yes: boolean;
  /** Feature answers given on the command line, e.g. `{ auth: "none" }`. */
  answers: Record<string, string>;
  /** Everything else, passed to setup unchanged. */
  rest: string[];
}

/** Splits forwarded setup arguments into answers we can skip asking and the rest. */
export const parseSetupFlags = (args: string[], featureIds: string[]): SetupFlags => {
  const flags: SetupFlags = { name: undefined, yes: false, answers: {}, rest: [] };
  const known = new Set(["name", ...featureIds]);

  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--yes") {
      flags.yes = true;
      continue;
    }
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    const key = match?.[1];
    if (match && key && known.has(key)) {
      let value = match[2];
      if (value === undefined) {
        const next = args[index + 1];
        if (next !== undefined && !next.startsWith("-")) {
          value = next;
          index++;
        }
      }
      if (value === undefined) throw new Error(`--${key} needs a value`);
      if (key === "name") flags.name = value;
      else flags.answers[key] = value;
      continue;
    }
    flags.rest.push(arg);
  }
  return flags;
};

/** Install-script approvals for the chosen options, or for every option in the template. */
export const allowBuildsFor = (
  choices: Choices,
  answers?: Record<string, string>,
): Record<string, boolean> => {
  const merged: Record<string, boolean> = { ...choices.allowBuilds };
  for (const feature of choices.features) {
    for (const option of feature.options) {
      if (answers !== undefined && answers[feature.id] !== option.value) continue;
      // An option that needs a script wins over one that only lists the package to skip it
      for (const [name, allowed] of Object.entries(option.allowBuilds ?? {})) {
        merged[name] = allowed || merged[name] === true;
      }
    }
  }
  return merged;
};

/**
 * Arguments for a non-interactive `pnpm setup:project` run with every answer filled in.
 * `--force` skips setup's uncommitted-changes check: the folder is new, and inside a monorepo
 * the repository is always dirty because of it.
 */
export const toSetupArgs = (name: string, answers: Record<string, string>, rest: string[]): string[] => [
  "--name",
  name,
  ...Object.entries(answers).flatMap(([feature, value]) => [`--${feature}`, value]),
  "--yes",
  ...(rest.includes("--force") ? [] : ["--force"]),
  ...rest,
];

/** Turns a folder name like "My Shop API" into a valid package name ("my-shop-api"). */
export const toProjectName = (folder: string): string =>
  folder
    .toLowerCase()
    .replace(/[^a-z0-9-._~]+/g, "-")
    .replace(/^[-._~]+|[-._~]+$/g, "") || "my-api";

const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

export const projectNameError = (name: string): string | undefined =>
  name.length > 0 && name.length <= 214 && NPM_NAME.test(name)
    ? undefined
    : 'Use lowercase letters, numbers, "-", "." or "_" (e.g. shop-api)';
