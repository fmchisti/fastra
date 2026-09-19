// Runs before every test file, before any app module is imported.
// Values set here win over `.env` because loading `.env` never overrides existing vars.
// Providers are replaced with fakes (see test/fakes), so no real credentials are needed.
Object.assign(process.env, {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  // @setup-if orm!=none
  DATABASE_URL: "postgresql://test:test@localhost:5432/test",
  // @setup-endif
  CORS_ORIGINS: "https://app.example.com",
  DOCS_USERNAME: "docs",
  DOCS_PASSWORD: "pa:ss:word",
});
