import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CrudRepository, PublicCrudRepository } from "../../src/lib/crud.ts";

export interface CrudHarness<TEntity, TCreate, TUpdate> {
  repository: CrudRepository<TEntity, TCreate, TUpdate>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

interface Entity {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

const MISSING_ID = "00000000-0000-4000-8000-000000000000";
// Rows created in the same millisecond tie on created_at (then order by id), so space them out
const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

/**
 * Behaviour every CrudRepository must have, regardless of ORM.
 * `create` and `update` are valid domain inputs (e.g. `CreateXBodySchema.parse(sample)`).
 */
export const describeCrudRepositoryContract = <
  TEntity extends Entity,
  TCreate extends object,
  TUpdate extends object,
>(
  name: string,
  createHarness: () => Promise<CrudHarness<TEntity, TCreate, TUpdate>>,
  samples: { create: TCreate; update: TUpdate },
) => {
  describe(`CrudRepository contract: ${name}`, () => {
    let harness: CrudHarness<TEntity, TCreate, TUpdate>;
    const repo = () => harness.repository;

    beforeAll(async () => {
      harness = await createHarness();
    });
    beforeEach(() => harness.reset());
    afterAll(() => harness.close());

    it("creates a record with id, timestamps, and the given fields", async () => {
      const created = await repo().create("alice", samples.create);

      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.createdAt).toBeInstanceOf(Date);
      expect(created.updatedAt).toBeInstanceOf(Date);
      expect(created).toMatchObject(samples.create);
    });

    it("finds by id only for the owner", async () => {
      const created = await repo().create("alice", samples.create);

      expect(await repo().findById("alice", created.id)).toEqual(created);
      expect(await repo().findById("bob", created.id)).toBeNull();
      expect(await repo().findById("alice", MISSING_ID)).toBeNull();
    });

    it("lists newest first with pagination and totals, scoped to the owner", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        ids.push((await repo().create("alice", samples.create)).id);
        await tick();
      }
      await repo().create("bob", samples.create);

      const first = await repo().list("alice", { page: 1, pageSize: 2 });
      expect(first.total).toBe(3);
      expect(first.items.map((item) => item.id)).toEqual([ids[2], ids[1]]);

      const second = await repo().list("alice", { page: 2, pageSize: 2 });
      expect(second.items.map((item) => item.id)).toEqual([ids[0]]);

      expect(await repo().list("carol", { page: 1, pageSize: 20 })).toEqual({ items: [], total: 0 });
    });

    it("updates provided fields only for the owner", async () => {
      const created = await repo().create("alice", samples.create);

      expect(await repo().update("bob", created.id, samples.update)).toBeNull();

      const updated = await repo().update("alice", created.id, samples.update);
      expect(updated).toMatchObject(samples.update);
      expect(updated?.id).toBe(created.id);
      expect(await repo().findById("alice", created.id)).toMatchObject(samples.update);
      expect(await repo().update("alice", MISSING_ID, samples.update)).toBeNull();
    });

    it("deletes only for the owner", async () => {
      const created = await repo().create("alice", samples.create);

      expect(await repo().delete("bob", created.id)).toBe(false);
      expect(await repo().delete("alice", created.id)).toBe(true);
      expect(await repo().findById("alice", created.id)).toBeNull();
      expect(await repo().delete("alice", created.id)).toBe(false);
    });
  });
};

export interface PublicCrudHarness<TEntity, TCreate, TUpdate> {
  repository: PublicCrudRepository<TEntity, TCreate, TUpdate>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** Behaviour every PublicCrudRepository must have, regardless of ORM. */
export const describePublicCrudRepositoryContract = <
  TEntity extends Entity,
  TCreate extends object,
  TUpdate extends object,
>(
  name: string,
  createHarness: () => Promise<PublicCrudHarness<TEntity, TCreate, TUpdate>>,
  samples: { create: TCreate; update: TUpdate },
) => {
  describe(`PublicCrudRepository contract: ${name}`, () => {
    let harness: PublicCrudHarness<TEntity, TCreate, TUpdate>;
    const repo = () => harness.repository;

    beforeAll(async () => {
      harness = await createHarness();
    });
    beforeEach(() => harness.reset());
    afterAll(() => harness.close());

    it("creates a record with id, timestamps, and the given fields", async () => {
      const created = await repo().create(samples.create);

      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.createdAt).toBeInstanceOf(Date);
      expect(created).toMatchObject(samples.create);
      expect(await repo().findById(created.id)).toEqual(created);
      expect(await repo().findById(MISSING_ID)).toBeNull();
    });

    it("lists newest first with pagination and totals", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        ids.push((await repo().create(samples.create)).id);
        await tick();
      }

      const first = await repo().list({ page: 1, pageSize: 2 });
      expect(first.total).toBe(3);
      expect(first.items.map((item) => item.id)).toEqual([ids[2], ids[1]]);
      expect((await repo().list({ page: 2, pageSize: 2 })).items.map((item) => item.id)).toEqual([ids[0]]);
    });

    it("updates provided fields and deletes", async () => {
      const created = await repo().create(samples.create);

      expect(await repo().update(created.id, samples.update)).toMatchObject(samples.update);
      expect(await repo().update(MISSING_ID, samples.update)).toBeNull();

      expect(await repo().delete(created.id)).toBe(true);
      expect(await repo().findById(created.id)).toBeNull();
      expect(await repo().delete(created.id)).toBe(false);
    });
  });
};

export interface ListHarness<TCreate, TQuery> {
  create(input: TCreate): Promise<{ id: string }>;
  list(query: TQuery): Promise<{ items: { id: string }[]; total: number }>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export interface ListCase<TQuery> {
  name: string;
  query: TQuery;
  /** Which of the two records the list returns, in order */
  expected: ("first" | "second")[];
}

/**
 * Search, sort, and filters of a list (`pnpm gen:module --search ... --sort ... --filter ...`).
 * Runs against the in-memory fake and the ORM, so both give the same answers.
 * `first` is created before `second`. Pass both type arguments, so query literals are checked.
 */
export const describeListContract = <TCreate, TQuery>(
  name: string,
  createHarness: () => Promise<ListHarness<TCreate, TQuery>>,
  samples: { first: TCreate; second: TCreate; cases: ListCase<TQuery>[] },
) => {
  describe(`list contract: ${name}`, () => {
    let harness: ListHarness<TCreate, TQuery>;

    beforeAll(async () => {
      harness = await createHarness();
    });
    beforeEach(() => harness.reset());
    afterAll(() => harness.close());

    it.each(samples.cases)("$name", async ({ query, expected }) => {
      const first = await harness.create(samples.first);
      await tick();
      const second = await harness.create(samples.second);
      const ids = { first: first.id, second: second.id };

      const page = await harness.list(query);

      expect(page.items.map((item) => item.id)).toEqual(expected.map((key) => ids[key]));
      expect(page.total).toBe(expected.length);
    });
  });
};
