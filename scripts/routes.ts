/**
 * `pnpm routes`: every route with its auth requirement and summary, read from the OpenAPI document.
 * The app is built with the test fakes, so it needs no database, Redis, or provider credentials.
 */
process.env.LOG_LEVEL ??= "silent";

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

const main = async (): Promise<void> => {
  const { buildTestApp } = await import("../test/helpers.ts");
  const app = await buildTestApp();
  try {
    const rows = Object.entries(app.swagger().paths ?? {}).flatMap(([path, item]) =>
      METHODS.flatMap((method) => {
        const operation = item?.[method];
        if (!operation) return [];
        return [
          {
            method: method.toUpperCase(),
            path,
            auth: (operation.security ?? []).length > 0 ? "user" : "public",
            summary: operation.summary ?? "",
          },
        ];
      }),
    );

    const width = (key: "method" | "path" | "auth") => Math.max(...rows.map((row) => row[key].length));
    for (const row of rows) {
      console.log(
        [
          row.method.padEnd(width("method")),
          row.path.padEnd(width("path")),
          row.auth.padEnd(width("auth")),
          row.summary,
        ].join("  "),
      );
    }
    console.log(`\n${rows.length} routes. "user" = needs a signed-in user. Full docs: /api/docs`);
  } finally {
    await app.close();
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
