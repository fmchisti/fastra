export interface NameForms {
  /** productCategory */
  camel: string;
  /** ProductCategory */
  pascal: string;
  /** product-category */
  kebab: string;
  /** product_category */
  snake: string;
  /** product category */
  words: string;
}

export interface ModuleNames {
  singular: NameForms;
  plural: NameForms;
}

export const FIELD_TYPES = [
  "string",
  "text",
  "int",
  "float",
  "decimal",
  "boolean",
  "datetime",
  "uuid",
  "enum",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface Field {
  /** camelCase property name */
  name: string;
  /** snake_case column name */
  column: string;
  type: FieldType;
  /** Nullable column, optional on create */
  optional: boolean;
  /** `enum(draft,published)`: the allowed values */
  values?: string[];
  /** `=value`: column default, and the value used when POST omits the field */
  default?: string;
  /** `!index`: the column gets an index */
  index: boolean;
}

export const FIELD_SYNTAX = `Fields: name:type[?][!index][=default], separated by spaces.
Types: string (≤255), text, int, float, decimal (money: 12 digits, 2 decimals, a string like "19.99" in JSON),
       boolean, datetime, uuid, enum(a,b,...).
  ?        optional (nullable)
  !index   index the column
  =value   default, for required fields: stock:int=0 active:boolean=true status:enum(draft,published)=draft`;

const isFieldType = (value: string): value is FieldType => (FIELD_TYPES as readonly string[]).includes(value);

const RESERVED_FIELDS = new Set(["id", "userId", "createdAt", "updatedAt"]);
const RESERVED_MODULES = new Set([
  "todo",
  "file",
  "health",
  "me",
  "auth",
  "user",
  "session",
  "account",
  "verification",
]);

const splitWords = (input: string): string[] =>
  input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .map((word) => word.toLowerCase())
    .filter(Boolean);

export const toForms = (words: string[]): NameForms => {
  const [first = "", ...rest] = words;
  const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
  return {
    camel: first + rest.map(capitalize).join(""),
    pascal: words.map(capitalize).join(""),
    kebab: words.join("-"),
    snake: words.join("_"),
    words: words.join(" "),
  };
};

export const pluralize = (word: string): string => {
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
};

/** "blog-post" → blogPost / blogPosts / blog_posts ... Pass `plural` for irregular words. */
export const parseModuleName = (
  input: string,
  plural?: string,
  // Reserved names cannot be created, but commands that change an existing module accept them
  { allowReserved = false }: { allowReserved?: boolean } = {},
): ModuleNames => {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(input)) {
    throw new Error(`Invalid module name "${input}": use letters, numbers, - or _ (e.g. product, blog-post)`);
  }
  const words = splitWords(input);
  const singular = toForms(words);
  if (!allowReserved && RESERVED_MODULES.has(singular.camel)) {
    throw new Error(`"${input}" is reserved by an existing module or table`);
  }

  const pluralWords = plural ? splitWords(plural) : [...words.slice(0, -1), pluralize(words.at(-1) ?? "")];
  const pluralForms = toForms(pluralWords);
  if (pluralForms.camel === singular.camel) {
    throw new Error(`Plural of "${input}" must differ from the singular; pass --plural`);
  }
  return { singular, plural: pluralForms };
};

/** Split on spaces and commas, but not on the commas inside `enum(a,b)`. */
const splitSpecs = (input: string): string[] => {
  const specs: string[] = [];
  let current = "";
  let depth = 0;
  for (const char of input) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (depth === 0 && /[\s,]/.test(char)) {
      if (current) specs.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) specs.push(current);
  return specs;
};

const DEFAULT_PATTERN: Partial<Record<FieldType, { pattern: RegExp; hint: string }>> = {
  string: { pattern: /^[^"\\`$]+$/, hint: "text without quotes or backslashes" },
  text: { pattern: /^[^"\\`$]+$/, hint: "text without quotes or backslashes" },
  int: { pattern: /^-?\d+$/, hint: "a whole number" },
  float: { pattern: /^-?\d+(\.\d+)?$/, hint: "a number" },
  decimal: { pattern: /^-?\d{1,10}(\.\d{1,2})?$/, hint: "a number with up to 2 decimals" },
  boolean: { pattern: /^(true|false)$/, hint: "true or false" },
};

/** "title:string price:decimal=0 status:enum(draft,published)=draft sku:string?!index" */
export const parseFields = (input: string): Field[] => {
  const specs = splitSpecs(input);
  if (specs.length === 0) throw new Error('Provide at least one field, e.g. --fields "name:string"');

  const seen = new Set<string>();
  return specs.map((spec) => {
    const match = /^([a-z][A-Za-z0-9]*):([a-z]+)(?:\(([^)]*)\))?(\?)?((?:![a-z]+)*)(?:=(.+))?$/.exec(spec);
    if (!match) {
      throw new Error(`Invalid field "${spec}".\n${FIELD_SYNTAX}`);
    }
    const [, name = "", type = "", list, optional, modifiers = "", defaultValue] = match;
    if (!isFieldType(type)) {
      throw new Error(`Invalid type "${type}" for ${name}. Types: ${FIELD_TYPES.join(", ")}`);
    }
    if (RESERVED_FIELDS.has(name))
      throw new Error(`"${name}" is added automatically; remove it from --fields`);
    if (seen.has(name)) throw new Error(`Duplicate field "${name}"`);
    seen.add(name);

    const field: Field = {
      name,
      column: toForms(splitWords(name)).snake,
      type,
      optional: optional === "?",
      index: false,
    };

    if ((type === "enum") !== (list !== undefined)) {
      throw new Error(
        type === "enum"
          ? `${name}: list the values, e.g. ${name}:enum(draft,published)`
          : `${name}: only enum takes a list of values`,
      );
    }
    if (list !== undefined) {
      const values = list.split(",").map((value) => value.trim());
      const invalid = values.filter((value) => !/^[a-z][a-z0-9_]*$/.test(value));
      if (invalid.length > 0 || values.length < 2 || new Set(values).size !== values.length) {
        throw new Error(
          `${name}: enum needs at least two different snake_case values, e.g. enum(draft,published)`,
        );
      }
      field.values = values;
    }

    for (const modifier of modifiers.split("!").filter(Boolean)) {
      if (modifier !== "index")
        throw new Error(`${name}: unknown modifier "!${modifier}". Modifiers: !index`);
      field.index = true;
    }

    if (defaultValue !== undefined) {
      if (field.optional)
        throw new Error(`${name}: an optional field defaults to null; remove ? or the default`);
      const rule = DEFAULT_PATTERN[type];
      const valid =
        type === "enum" ? (field.values ?? []).includes(defaultValue) : rule?.pattern.test(defaultValue);
      if (!valid) {
        const expected = type === "enum" ? `one of ${field.values?.join(", ")}` : rule?.hint;
        throw new Error(
          expected
            ? `${name}: default "${defaultValue}" must be ${expected}`
            : `${name}: ${type} fields cannot have a default`,
        );
      }
      field.default = defaultValue;
    }
    return field;
  });
};
