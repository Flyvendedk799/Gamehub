/**
 * Database client factory. Services call `createDb(connectionString)` once at
 * boot and share the returned Drizzle instance. The full schema is attached so
 * queries are fully typed end-to-end.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';

export * as schema from './schema/index';
export type Schema = typeof schema;

export interface CreateDbOptions {
  /** postgres-js pool options (max connections, ssl, etc.). */
  max?: number;
}

export function createDb(connectionString: string, opts: CreateDbOptions = {}) {
  const client = postgres(connectionString, { max: opts.max ?? 10 });
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;
