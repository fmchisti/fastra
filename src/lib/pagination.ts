import { z } from "zod";

/**
 * Highest page a list accepts. Postgres reads and discards every skipped row, so an unbounded
 * `?page=` is an easy way to make one request expensive. To go deeper, narrow the list with
 * filters or search, or page by key (`where created_at < :last`).
 */
export const MAX_PAGE = 500;

export const PaginationQuerySchema = z.object({
  page: z.coerce.number<string>().int().min(1).max(MAX_PAGE).default(1),
  pageSize: z.coerce.number<string>().int().min(1).max(100).default(20),
});

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export interface Page<T> {
  items: T[];
  total: number;
}

/** Response schema for a paginated list of `item`. */
export const paginatedSchema = <TItem extends z.ZodType>(item: TItem) =>
  z.object({
    items: z.array(item),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  });

export const toPaginatedResponse = <T>(page: Page<T>, query: PaginationQuery) => ({
  items: page.items,
  page: query.page,
  pageSize: query.pageSize,
  total: page.total,
  totalPages: Math.ceil(page.total / query.pageSize),
});

/** Offset for SQL/ORM queries. */
export const toOffset = ({ page, pageSize }: PaginationQuery): number => (page - 1) * pageSize;
