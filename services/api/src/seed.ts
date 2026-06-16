/**
 * Dev seed script — creates a usable dev account with known credentials.
 * Run once after applying migrations:
 *   DATABASE_URL=postgres://... pnpm --filter @playforge/api seed
 */
import { eq } from 'drizzle-orm';
import { createDb, schema } from '@playforge/db';
import { generateSessionToken, hashPassword, sessionExpiresAt } from './auth';

const DEV_EMAIL = 'dev@playforge.local';
const DEV_PASSWORD = 'devpassword123';
const DEV_HANDLE = 'devuser';
const DEV_DISPLAY_NAME = 'Dev User';
const FREE_TIER_CREDITS = 100;

async function seed() {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL not set');
  const db = createDb(databaseUrl);

  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, DEV_EMAIL));

  if (existing) {
    console.log(`Dev account already exists: @${DEV_HANDLE} (${DEV_EMAIL})`);
    console.log(`Password: ${DEV_PASSWORD}`);
    process.exit(0);
  }

  const passwordHash = await hashPassword(DEV_PASSWORD);
  const [user] = await db
    .insert(schema.users)
    .values({ email: DEV_EMAIL, passwordHash, handle: DEV_HANDLE, displayName: DEV_DISPLAY_NAME })
    .returning({ id: schema.users.id });

  if (!user) throw new Error('User insert returned no row');

  await db.insert(schema.creditLedger).values({
    userId: user.id,
    delta: FREE_TIER_CREDITS,
    reason: 'welcome_grant',
  });

  const token = generateSessionToken();
  await db.insert(schema.sessions).values({ token, userId: user.id, expiresAt: sessionExpiresAt() });

  console.log('Dev account created:');
  console.log(`  Email:    ${DEV_EMAIL}`);
  console.log(`  Password: ${DEV_PASSWORD}`);
  console.log(`  Handle:   @${DEV_HANDLE}`);
  console.log(`  Token:    ${token}`);
}

void seed().catch((err: unknown) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
