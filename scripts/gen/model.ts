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

export const FIELD_TYPES = ["string", "text", "int", "float", "boolean", "datetime"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface Field {
  /** camelCase property name */
  name: string;
  /** snake_case column name */
  column: string;
  type: FieldType;
  /** Nullable column, optional on create */
  optional: boolean;
}

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

/** "title:string price:float? publishedAt:datetime?" */
export const parseFields = (input: string): Field[] => {
  const specs = input.split(/[\s,]+/).filter(Boolean);
  if (specs.length === 0) throw new Error('Provide at least one field, e.g. --fields "name:string"');

  const seen = new Set<string>();
  return specs.map((spec) => {
    const match = /^([a-z][A-Za-z0-9]*):([a-z]+)(\?)?$/.exec(spec);
    if (!match) {
      throw new Error(
        `Invalid field "${spec}": use camelCaseName:type, add ? for optional (e.g. price:float?)`,
      );
    }
    const [, name = "", type = "", optional] = match;
    if (!isFieldType(type)) {
      throw new Error(`Invalid type "${type}" for ${name}. Types: ${FIELD_TYPES.join(", ")}`);
    }
    if (RESERVED_FIELDS.has(name))
      throw new Error(`"${name}" is added automatically; remove it from --fields`);
    if (seen.has(name)) throw new Error(`Duplicate field "${name}"`);
    seen.add(name);

    return { name, column: toForms(splitWords(name)).snake, type, optional: optional === "?" };
  });
};
