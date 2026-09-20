/**
 * The narrowest thing that can run our SQL.
 *
 * Prisma's typed client is the right tool for ordinary product tables, and
 * `src/lib/db.ts` stays the place to get it. It is the wrong tool for the
 * behaviour pipe: `events.behavior_event` is a partitioned parent that Prisma
 * cannot introspect, and the de-duplication rule is an `ON CONFLICT DO NOTHING`
 * on a three-column primary key that Prisma's `createMany` cannot express.
 *
 * So the pipe speaks SQL, through this one-method interface. `pg.Pool`
 * satisfies it as-is in production, and `@electric-sql/pglite` satisfies it in
 * tests — which is how `pg-sink.test.ts` can run the real migrations and the
 * real inserts in CI without a database server, and therefore how
 * "a duplicate delivery does not create a duplicate row" is a fact we check
 * rather than a sentence we wrote.
 */

export interface SqlResult<Row = Record<string, unknown>> {
  readonly rows: Row[];
}

export interface SqlExecutor {
  query<Row = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<SqlResult<Row>>;
}
