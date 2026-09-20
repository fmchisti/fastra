import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseName } from "../../scripts/gen/model.ts";
import { generateClient, planClient } from "../../scripts/gen-client.ts";

let root = "";
afterEach(() => rm(root, { recursive: true, force: true }));

const FILES = {
  "src/container.ts":
    'import { a } from "./a.ts";\ninterface D {\n  // @gen:dependencies\n}\nconst d = {\n  // @gen:factories\n};\n',
  "src/app.ts": 'import { b } from "./b.ts";\n  // @gen:routes\n',
  "src/config/swagger.ts": "tags: [\n  // @gen:tags\n],\n",
  "test/helpers.ts": 'import { c } from "./c.ts";\n  // @gen:fakes\n',
  ".env.example": "PORT=3000\n",
};

const createProject = async (files: Record<string, string> = FILES): Promise<void> => {
  root = await mkdtemp(path.join(tmpdir(), "gen-client-"));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
};

const read = (file: string) => readFile(path.join(root, file), "utf8");

describe("parseName", () => {
  it("derives the forms used for files, identifiers, and env variables", () => {
    expect(parseName("open-weather")).toMatchObject({
      camel: "openWeather",
      pascal: "OpenWeather",
      kebab: "open-weather",
      snake: "open_weather",
    });
    expect(() => parseName("1password")).toThrow(/Invalid name/);
  });
});

describe("planClient", () => {
  it("protects the route only when asked", () => {
    const routes = (protectedRoutes: boolean) =>
      planClient(parseName("weather"), protectedRoutes).find((file) => file.path.endsWith("routes.ts"))
        ?.content ?? "";

    expect(routes(true)).toContain('fastify.addHook("onRequest", authenticate);');
    expect(routes(false)).not.toContain("import { authenticate }");
    expect(routes(false)).toContain('url: "/weather/:id"');
  });
});

describe("generateClient", () => {
  it("writes the module and registers it at every marker", async () => {
    await createProject();

    const created = await generateClient({ root, name: "open-weather", skipTooling: true });

    expect(created).toContain("src/modules/open-weather/client.ts");
    expect(await read("src/container.ts")).toContain(
      "openWeather: OpenWeatherClient;\n  // @gen:dependencies",
    );
    expect(await read("src/container.ts")).toContain(
      "openWeather: overrides.openWeather ?? createOpenWeatherClient(loadOpenWeatherClientOptions()),",
    );
    expect(await read("src/app.ts")).toContain(
      'await app.register(openWeatherRoutes, { prefix: "/api", client: deps.openWeather });',
    );
    expect(await read("test/helpers.ts")).toContain("openWeather: createFakeOpenWeatherClient(),");
    expect(await read(".env.example")).toContain("OPEN_WEATHER_API_URL=https://api.example.com\n");
    // Public because this project has no src/auth
    expect(await read("src/modules/open-weather/routes.ts")).not.toContain("import { authenticate }");
  });

  it("drops the empty-interface suppression of a project that had no dependencies", async () => {
    await createProject({
      ...FILES,
      "src/container.ts": `// biome-ignore lint/suspicious/noEmptyInterface: add fields later\n${FILES["src/container.ts"]}`,
    });

    await generateClient({ root, name: "weather", skipTooling: true });

    expect(await read("src/container.ts")).not.toContain("biome-ignore");
  });

  it("changes nothing when a marker is missing", async () => {
    await createProject({ ...FILES, "src/app.ts": "// no marker\n" });

    await expect(generateClient({ root, name: "weather", skipTooling: true })).rejects.toThrow(
      /marker "@gen:routes" not found/,
    );
    expect(await read("src/container.ts")).toBe(FILES["src/container.ts"]);
    await expect(read("src/modules/weather/client.ts")).rejects.toThrow();
  });

  it("refuses an existing module and lists files in a dry run", async () => {
    await createProject();

    expect(await generateClient({ root, name: "weather", dryRun: true })).toHaveLength(9);
    await generateClient({ root, name: "weather", skipTooling: true });
    await expect(generateClient({ root, name: "weather", skipTooling: true })).rejects.toThrow(
      "src/modules/weather already exists",
    );
  });
});
