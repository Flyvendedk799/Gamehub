-- Engine Evolution v2 Phase 8: first-class canvas2d engine target.
-- Additive enum value — applied via psql at deploy (NOT drizzle-kit). ADD VALUE
-- with IF NOT EXISTS is idempotent and safe on existing rows.
ALTER TYPE "engine_kind" ADD VALUE IF NOT EXISTS 'canvas2d';
