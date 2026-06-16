-- Phase 4: pgvector Hub search
-- Adds 1536-dimensional embeddings to published_games for semantic search.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "published_games" ADD COLUMN IF NOT EXISTS "embedding" vector(1536);

CREATE INDEX IF NOT EXISTS "published_games_embedding_idx"
  ON "published_games" USING hnsw ("embedding" vector_cosine_ops);
