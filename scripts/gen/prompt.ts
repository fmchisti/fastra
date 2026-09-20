import * as p from "@clack/prompts";
import { FIELD_TYPES, type FieldType, parseFields, parseModuleName } from "./model.ts";

/** Answers for one field, turned into the `name:type[?][!index][=default]` syntax of --fields. */
export interface FieldAnswers {
  name: string;
  type: FieldType;
  values?: string;
  optional: boolean;
  index: boolean;
  default?: string;
}

export const toFieldSpec = (field: FieldAnswers): string =>
  [
    `${field.name}:${field.type}`,
    field.type === "enum" ? `(${(field.values ?? "").replace(/\s+/g, "")})` : "",
    field.optional ? "?" : "",
    field.index ? "!index" : "",
    field.default ? `=${field.default}` : "",
  ].join("");

/** Whether to ask questions: only in a terminal, never in CI or a pipe. */
export const canPrompt = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);

const TYPE_HINTS: Record<FieldType, string> = {
  string: "up to 255 characters",
  text: "long text",
  int: "whole number",
  float: "number",
  decimal: 'money: exact, "19.99"',
  boolean: "true / false",
  datetime: "date and time",
  uuid: "id of something else",
  enum: "one of a fixed list",
};

const cancelled = (): never => {
  p.cancel("Cancelled. Nothing was changed.");
  process.exit(0);
};

const ask = async <T>(question: Promise<T>): Promise<Exclude<T, symbol>> => {
  const answer = await question;
  if (p.isCancel(answer)) return cancelled();
  return answer as Exclude<T, symbol>;
};

/** Message for clack's `validate`: undefined when `check` does not throw. */
const errorOf = (check: () => unknown): string | undefined => {
  try {
    check();
    return undefined;
  } catch (error) {
    return error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error);
  }
};

export const promptModuleName = (): Promise<string> =>
  ask(
    p.text({
      message: "Module name (singular)",
      placeholder: "product, blog-post",
      validate: (value) => errorOf(() => parseModuleName(value ?? "")),
    }),
  );

/** Asks for fields until the name is left empty. Returns the --fields string. */
export const promptFields = async (existing: string[] = []): Promise<string> => {
  const specs: string[] = [];
  for (;;) {
    const name = await ask(
      p.text({
        message: specs.length === 0 ? "Field name" : "Next field name (empty to finish)",
        placeholder: "price",
        validate: (value) => {
          if (!value) return specs.length === 0 ? "Add at least one field" : undefined;
          if (existing.includes(value)) return `"${value}" already exists`;
          return errorOf(() => parseFields([...specs, `${value}:string`].join(" ")));
        },
      }),
    );
    if (!name) break;

    const type = await ask(
      p.select({
        message: `Type of ${name}`,
        options: FIELD_TYPES.map((value) => ({ value, label: value, hint: TYPE_HINTS[value] })),
      }),
    );
    const field: FieldAnswers = { name, type, optional: false, index: false };
    if (type === "enum") {
      field.values = await ask(
        p.text({
          message: "Values, comma-separated",
          placeholder: "draft,published",
          validate: (value) => errorOf(() => parseFields(toFieldSpec({ ...field, values: value ?? "" }))),
        }),
      );
    }
    field.optional = await ask(p.confirm({ message: "Optional (can be null)?", initialValue: false }));
    if (!field.optional && type !== "datetime" && type !== "uuid") {
      const fallback = await ask(
        p.text({
          message: "Default value (empty for none)",
          placeholder: (type === "enum" ? field.values?.split(",")[0]?.trim() : undefined) ?? "",
          validate: (value) =>
            value ? errorOf(() => parseFields(toFieldSpec({ ...field, default: value }))) : undefined,
        }),
      );
      if (fallback) field.default = fallback;
    }
    field.index = await ask(p.confirm({ message: "Index this column?", initialValue: false }));
    specs.push(toFieldSpec(field));
  }
  return specs.join(" ");
};

export const promptConfirm = (message: string, initialValue = true): Promise<boolean> =>
  ask(p.confirm({ message, initialValue }));

export const intro = (title: string): void => p.intro(title);
export const note = (message: string, title: string): void => p.note(message, title);
