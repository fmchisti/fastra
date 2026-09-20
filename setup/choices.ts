import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CORE_ALLOW_BUILDS, FEATURE_IDS, type FeatureId, features, type OptionManifest } from "./features.ts";

/**
 * The questions setup asks, as plain JSON. `create-fastra` reads `setup/choices.json` right after
 * downloading the template, so it can ask everything before installing dependencies.
 * Regenerate with `pnpm setup:choices` after changing `features.ts` (a test fails if it is stale).
 */
export interface Choices {
  version: 1;
  /** Install-script approvals every project needs (options add their own). */
  allowBuilds: Record<string, boolean>;
  features: {
    id: string;
    label: string;
    default: string;
    options: {
      value: string;
      label: string;
      hint?: string;
      requires?: Record<string, string[]>;
      allowBuilds?: Record<string, boolean>;
    }[];
  }[];
}

export const CHOICES_FILE = "setup/choices.json";

export const buildChoices = (): Choices => ({
  version: 1,
  allowBuilds: CORE_ALLOW_BUILDS,
  features: FEATURE_IDS.map((id: FeatureId) => {
    const options: Record<string, OptionManifest> = features[id].options;
    return {
      id,
      label: features[id].label,
      default: features[id].default,
      options: Object.entries(options).map(([value, option]) => ({
        value,
        label: option.label,
        ...(option.hint && { hint: option.hint }),
        ...(option.requires && { requires: option.requires }),
        ...(option.allowBuilds && { allowBuilds: option.allowBuilds }),
      })),
    };
  }),
});

const isEntryPoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  const file = path.resolve(import.meta.dirname, "..", CHOICES_FILE);
  await writeFile(file, `${JSON.stringify(buildChoices(), null, 2)}\n`);
  // Biome lays out short arrays differently from JSON.stringify, and `pnpm check` compares formatting
  execFileSync("pnpm", ["exec", "biome", "format", "--write", file], { stdio: "ignore" });
  console.log(`Wrote ${CHOICES_FILE}`);
}
