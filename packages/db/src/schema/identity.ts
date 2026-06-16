/**
 * Identity & billing schema — native auth (email + password, session tokens).
 *
 * No third-party auth provider. Sessions are random tokens stored in the
 * `sessions` table; clients send `Authorization: Bearer <token>`. Passwords
 * are hashed with scrypt (Node built-in). The `users` table is self-contained —
 * no external subject ID needed.
 */
import { sql } from 'drizzle-orm';
import {
  bigserial,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const subscriptionTier = pgEnum('subscription_tier', ['free', 'plus', 'pro', 'team']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    handle: text('handle').notNull(),
    displayName: text('display_name').notNull(),
    avatarUrl: text('avatar_url'),
    bio: text('bio'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    emailIdx: uniqueIndex('users_email_key').on(t.email),
    handleIdx: uniqueIndex('users_handle_key').on(t.handle),
  }),
);

/** Opaque session tokens. Each login creates one row; logout deletes it. */
export const sessions = pgTable(
  'sessions',
  {
    token: text('token').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: uniqueIndex('sessions_user_idx').on(t.userId, t.createdAt),
  }),
);

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  stripeCustomerId: text('stripe_customer_id').notNull(),
  stripeSubscriptionId: text('stripe_subscription_id'),
  tier: subscriptionTier('tier').notNull().default('free'),
  status: text('status').notNull(),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Append-only credit ledger. Current balance = SUM(delta) per user. */
export const creditLedger = pgTable(
  'credit_ledger',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    delta: integer('delta').notNull(),
    reason: text('reason').notNull(),
    runId: uuid('run_id'),
    stripeEventId: text('stripe_event_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userCreatedIdx: uniqueIndex('credit_ledger_user_event_key')
      .on(t.userId, t.stripeEventId)
      .where(sql`${t.stripeEventId} is not null`),
  }),
);

/** BYOK provider keys, envelope-encrypted at rest (KMS). */
export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  ciphertext: text('ciphertext').notNull(),
  last4: text('last4'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
