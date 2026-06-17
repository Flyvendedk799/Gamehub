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
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
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
    // NON-unique: two near-simultaneous logins by the same user can land on the
    // same created_at; a unique index here would 500 the second login. This is
    // a plain lookup index, not a constraint.
    userIdx: index('sessions_user_idx').on(t.userId, t.createdAt),
  }),
);

/**
 * Creator follows (Phase 3.9). A directed edge: `followerId` follows
 * `followeeId`. UNIQUE(follower_id, followee_id) makes follow idempotent
 * (the route uses onConflictDoNothing); self-follows are rejected at the route.
 * The followee_id index backs the follower-count + isFollowing reads on the
 * creator-profile response. Both columns cascade-delete with the user.
 */
export const follows = pgTable(
  'follows',
  {
    followerId: uuid('follower_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    followeeId: uuid('followee_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.followerId, t.followeeId] }),
    // Count a creator's followers / check isFollowing without scanning.
    followeeIdx: index('follows_followee_idx').on(t.followeeId),
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
    // One reservation row per run — makes the enqueue-time RESERVE insert
    // idempotent under concurrent/retried generate calls.
    reservationKey: uniqueIndex('credit_ledger_reservation_key')
      .on(t.runId)
      .where(sql`${t.reason} = 'reservation'`),
    // One refund row per run — a failed run refunds exactly once even if the
    // worker 'failed' handler and the in-process .catch both fire.
    refundKey: uniqueIndex('credit_ledger_refund_key')
      .on(t.runId)
      .where(sql`${t.reason} = 'refund'`),
    // Covering index for the per-user balance SUM(delta).
    userIdx: index('credit_ledger_user_idx').on(t.userId),
  }),
);

/**
 * Single-use password-reset tokens (Phase 6.2). The forgot-password route mints
 * a random token, stores ONLY its hash here (never the raw value), and "sends"
 * the raw token to the user via the EmailPort. The reset route validates the
 * presented token's hash against an unexpired, unused row, then sets `used_at`
 * so the token can't be replayed. Rows cascade-delete with the user.
 */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 hex of the raw token — the raw value is never persisted. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set once when the token is consumed; a non-null value rejects replays. */
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Constant-time-ish single-row lookup by the presented token's hash.
    tokenHashIdx: uniqueIndex('password_reset_tokens_hash_key').on(t.tokenHash),
    // Lookup all of a user's outstanding tokens (e.g. to invalidate on reset).
    userIdx: index('password_reset_tokens_user_idx').on(t.userId),
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
