-- Account onboarding + provider settings.
-- Users can keep platform credits or choose BYOK for Anthropic Claude/OpenAI.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "default_provider" text DEFAULT 'platform' NOT NULL;--> statement-breakpoint
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "default_model_id" text;--> statement-breakpoint
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "onboarding_completed_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_user_provider_key"
  ON "api_keys" ("user_id", "provider");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "api_keys_user_idx"
  ON "api_keys" ("user_id");
