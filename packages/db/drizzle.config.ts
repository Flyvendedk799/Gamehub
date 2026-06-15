import { defineConfig } from 'drizzle-kit';

/** drizzle-kit config. `db:generate` emits SQL migrations from the schema;
 *  `db:migrate` applies them. DATABASE_URL is only needed for `db:migrate`. */
export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/playforge',
  },
});
