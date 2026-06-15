// Canonical definitions live in @playforge/shared to avoid a
// circular dependency: packages/providers needs LoadedSkill but
// packages/providers is already a dependency of packages/core.
// Re-export here so skill-internal code can import from './types.js'.
export { SkillFrontmatterV1 } from '@playforge/shared';
export type { LoadedSkill } from '@playforge/shared';
