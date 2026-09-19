import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** A comment with this command right above an empty variable marks it as a secret to generate. */
const SECRET_HINT = "openssl rand -base64 32";

export const generateSecret = (): string => randomBytes(32).toString("base64");

/**
 * `.env` contents from `.env.example`: empty variables whose comment is `# openssl rand -base64 32`
 * get a random value, everything else is copied as is.
 */
export const fillSecrets = (example: string, secret: () => string = generateSecret): string => {
  const lines = example.split("\n");
  return lines
    .map((line, index) => {
      const isEmptyVariable = /^[A-Z0-9_]+=$/.test(line);
      const comment = lines[index - 1] ?? "";
      return isEmptyVariable && comment.startsWith("#") && comment.includes(SECRET_HINT)
        ? `${line}${secret()}`
        : line;
    })
    .join("\n");
};

/** Create `.env` from `.env.example`. Returns false, and changes nothing, when `.env` already exists. */
export const initEnv = async (root: string): Promise<boolean> => {
  const target = path.join(root, ".env");
  if (existsSync(target)) return false;
  await writeFile(target, fillSecrets(await readFile(path.join(root, ".env.example"), "utf8")));
  return true;
};

const main = async (): Promise<void> => {
  const created = await initEnv(process.cwd());
  console.log(
    created
      ? "Created .env from .env.example (secrets generated). Review the values."
      : ".env already exists: left unchanged.",
  );
};

const isEntryPoint = process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename;
if (isEntryPoint) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
