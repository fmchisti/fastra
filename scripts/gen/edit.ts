/**
 * Text edits for files that `gen:module` wrote and a developer may have changed since.
 * Every edit finds its place by an anchor and throws `AnchorError` when the anchor is gone,
 * so a command can plan all edits first and write nothing unless every one of them fits.
 */

export class AnchorError extends Error {
  override name = "AnchorError";
}

export interface BlockInsert {
  /** First line of the block, e.g. `export const ProductSchema = z.object({` */
  start: RegExp;
  /** Line inside the block to insert before, e.g. the `createdAt` line or the closing `});` */
  before: RegExp;
  lines: string[];
  /**
   * `same`: indent like the `before` line (inserting next to a sibling).
   * `inner`: two spaces deeper (inserting before a closing bracket).
   */
  indent: "same" | "inner";
}

/** Line range [start, end) of a block: from `start` to the first later line matching `before`. */
const findBlock = (lines: string[], edit: Pick<BlockInsert, "start" | "before">, file: string) => {
  const start = lines.findIndex((line) => edit.start.test(line));
  if (start === -1) throw new AnchorError(`${file}: could not find ${edit.start}`);
  const offset = lines.slice(start + 1).findIndex((line) => edit.before.test(line));
  if (offset === -1) throw new AnchorError(`${file}: could not find ${edit.before} after ${edit.start}`);
  return { start, end: start + 1 + offset };
};

export const insertInBlock = (content: string, edit: BlockInsert, file: string): string => {
  const lines = content.split("\n");
  const { end } = findBlock(lines, edit, file);
  const anchorIndent = /^\s*/.exec(lines[end] ?? "")?.[0] ?? "";
  const indent = edit.indent === "inner" ? `${anchorIndent}  ` : anchorIndent;
  lines.splice(end, 0, ...edit.lines.map((line) => `${indent}${line}`));
  return lines.join("\n");
};

/** Whether the block already has a `name:` (TypeScript) or `name ` (Prisma) entry. */
export const blockHasKey = (
  content: string,
  block: Pick<BlockInsert, "start" | "before">,
  key: string,
  file: string,
): boolean => {
  const lines = content.split("\n");
  const { start, end } = findBlock(lines, block, file);
  const entry = new RegExp(`^\\s*${key}[:\\s]`);
  return lines.slice(start + 1, end).some((line) => entry.test(line));
};

/** Add names to `import { ... } from "<source>"` (one line or several). Biome sorts them afterwards. */
export const addNamedImports = (content: string, source: string, names: string[], file: string): string => {
  const escaped = source.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const statement = new RegExp(`import \\{([^}]*)\\} from "${escaped}";`);
  const match = statement.exec(content);
  if (!match) throw new AnchorError(`${file}: could not find the import from "${source}"`);
  const existing = (match[1] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const merged = [...new Set([...existing, ...names])].sort();
  return content.replace(statement, `import { ${merged.join(", ")} } from "${source}";`);
};

/** Insert whole lines (plus a blank line) right before the first line matching `start`. */
export const insertBeforeLine = (
  content: string,
  start: RegExp,
  newLines: string[],
  file: string,
): string => {
  const lines = content.split("\n");
  const index = lines.findIndex((line) => start.test(line));
  if (index === -1) throw new AnchorError(`${file}: could not find ${start}`);
  lines.splice(index, 0, ...newLines, "");
  return lines.join("\n");
};

/** Insert `text` right after the first match of `anchor`, e.g. new items after an array's `[`. */
export const insertAfterMatch = (content: string, anchor: RegExp, text: string, file: string): string => {
  const match = anchor.exec(content);
  if (!match) throw new AnchorError(`${file}: could not find ${anchor}`);
  const end = match.index + match[0].length;
  return `${content.slice(0, end)}${text}${content.slice(end)}`;
};
