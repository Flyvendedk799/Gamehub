-- Native auth: replace Clerk external subject with email + password_hash.
-- Add sessions table for opaque Bearer tokens.

-- Drop the Clerk unique index first (can't drop column with index)
DROP INDEX IF EXISTS "users_clerk_user_id_key";--> statement-breakpoint

-- Add native auth columns (nullable initially so existing rows survive)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_hash" text;--> statement-breakpoint

-- Backfill dev seed row so it has valid values before we add NOT NULL
UPDATE "users"
  SET email = handle || '@playforge.local',
      password_hash = 'dev-seed-no-password'
  WHERE email IS NULL;--> statement-breakpoint

-- Now enforce NOT NULL
ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" SET NOT NULL;--> statement-breakpoint

-- Unique index on email
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users" ("email");--> statement-breakpoint

-- Drop the old Clerk column
ALTER TABLE "users" DROP COLUMN IF EXISTS "clerk_user_id";--> statement-breakpoint

-- Sessions table
CREATE TABLE IF NOT EXISTS "sessions" (
  "token" text PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "sessions_user_idx" ON "sessions" ("user_id", "created_at");
