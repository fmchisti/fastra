import { createAuthProvider } from "./auth/index.ts"; // @setup-if auth!=none
import type { AuthProvider } from "./auth/types.ts"; // @setup-if auth!=none
import { type AppDatabase, createDatabase, type Database } from "./db/index.ts"; // @setup-if orm!=none
import { createTodoRepository, type TodoRepository } from "./modules/todos/repository/index.ts"; // @setup-if auth!=none&orm!=none
import { createRedis, type Redis } from "./redis/index.ts"; // @setup-if redis=redis
import { createStorage, type StorageProvider } from "./storage/index.ts"; // @setup-if storage=s3,local

/**
 * Everything the app needs from the outside world.
 * `buildApp()` creates the selected implementations; tests pass fakes instead.
 * Add a field here when a new module needs a repository or external service.
 */
// @setup-if auth=none&orm=none&redis=none
// @setup-emit // biome-ignore lint/suspicious/noEmptyInterface: add fields when the project gets external dependencies
// @setup-endif
export interface AppDependencies {
  // @setup-if orm!=none
  database: Database;
  // @setup-endif
  // @setup-if auth!=none
  auth: AuthProvider;
  // @setup-endif
  // @setup-if auth!=none&orm!=none
  todos: TodoRepository;
  // @setup-endif
  // @gen:dependencies (pnpm gen:module inserts repositories above)
  // @setup-if storage=s3,local
  storage: StorageProvider;
  // @setup-endif
  // @setup-if redis=redis
  redis: Redis;
  // @setup-endif
}

export interface DependencyConfig {
  corsOrigins: string[];
}

/** Dependencies plus `close()`, which releases every connection on shutdown. */
export type AppContainer = AppDependencies & { close(): Promise<void> };

export const createDependencies = (
  overrides: Partial<AppDependencies>,
  // @setup-if auth=none
  // @setup-emit // biome-ignore lint/correctness/noUnusedFunctionParameters: kept so adding an auth provider later needs no signature change
  // @setup-endif
  config: DependencyConfig,
): AppContainer => {
  // @setup-if orm!=none
  // Created only if something below needs it, so tests with fakes never open a pool
  let database: AppDatabase | undefined;
  const getDatabase = (): AppDatabase => (database ??= createDatabase());
  // @setup-endif

  const deps: AppDependencies = {
    // @setup-if auth!=none
    auth:
      overrides.auth ??
      createAuthProvider({
        // @setup-if orm!=none
        database: getDatabase,
        // @setup-endif
        trustedOrigins: config.corsOrigins,
      }),
    // @setup-endif
    // @setup-if auth!=none&orm!=none
    todos: overrides.todos ?? createTodoRepository(getDatabase()),
    // @setup-endif
    // @gen:factories
    // @setup-if storage=s3,local
    storage: overrides.storage ?? createStorage(),
    // @setup-endif
    // @setup-if redis=redis
    redis: overrides.redis ?? createRedis(),
    // @setup-endif
    // @setup-if orm!=none
    database: overrides.database ?? getDatabase(),
    // @setup-endif
  };

  return {
    ...overrides,
    ...deps,
    close: async () => {
      // @setup-if auth!=none
      await deps.auth.close?.();
      // @setup-endif
      // @setup-if orm!=none
      await deps.database.close();
      // @setup-endif
      // @setup-if redis=redis
      await deps.redis.quit();
      // @setup-endif
    },
  };
};
