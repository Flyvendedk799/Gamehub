import { randomUUID } from 'node:crypto';
import { type Db, schema } from '@playforge/db';
import { and, eq, isNull } from 'drizzle-orm';

export const BYOK_PROVIDERS = ['anthropic', 'openai'] as const;
export type ByokProvider = (typeof BYOK_PROVIDERS)[number];
export type AccountProvider = 'platform' | ByokProvider;

export interface SavedProviderKey {
  id: string;
  provider: ByokProvider;
  ciphertext: string;
  last4: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountSettings {
  userId: string;
  email: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  defaultProvider: AccountProvider;
  defaultModelId: string | null;
  onboardingCompletedAt: string | null;
  keys: SavedProviderKey[];
}

export interface UpdateProfileInput {
  displayName?: string;
  bio?: string | null;
  avatarUrl?: string | null;
}

export interface SaveProviderInput {
  provider: AccountProvider;
  modelId: string | null;
  markOnboardingComplete: boolean;
}

export interface SaveApiKeyInput {
  provider: ByokProvider;
  ciphertext: string;
  last4: string;
}

export interface AccountRepo {
  getSettings(userId: string): Promise<AccountSettings | null>;
  updateProfile(userId: string, input: UpdateProfileInput): Promise<AccountSettings | null>;
  saveProvider(userId: string, input: SaveProviderInput): Promise<AccountSettings | null>;
  saveApiKey(userId: string, input: SaveApiKeyInput): Promise<SavedProviderKey>;
  deleteApiKey(userId: string, provider: ByokProvider): Promise<void>;
}

export function isByokProvider(provider: string): provider is ByokProvider {
  return (BYOK_PROVIDERS as readonly string[]).includes(provider);
}

export function isAccountProvider(provider: string): provider is AccountProvider {
  return provider === 'platform' || isByokProvider(provider);
}

function normalizeAccountProvider(provider: string): AccountProvider {
  return isAccountProvider(provider) ? provider : 'platform';
}

function rowToKey(row: typeof schema.apiKeys.$inferSelect): SavedProviderKey {
  return {
    id: row.id,
    provider: isByokProvider(row.provider) ? row.provider : 'openai',
    ciphertext: row.ciphertext,
    last4: row.last4 ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type UserRow = Pick<
  typeof schema.users.$inferSelect,
  | 'id'
  | 'email'
  | 'handle'
  | 'displayName'
  | 'avatarUrl'
  | 'bio'
  | 'defaultProvider'
  | 'defaultModelId'
  | 'onboardingCompletedAt'
>;

function rowToSettings(user: UserRow, keys: SavedProviderKey[]): AccountSettings {
  return {
    userId: user.id,
    email: user.email,
    handle: user.handle,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl ?? null,
    bio: user.bio ?? null,
    defaultProvider: normalizeAccountProvider(user.defaultProvider),
    defaultModelId: user.defaultModelId ?? null,
    onboardingCompletedAt: user.onboardingCompletedAt?.toISOString() ?? null,
    keys,
  };
}

export class DrizzleAccountRepo implements AccountRepo {
  constructor(private readonly db: Db) {}

  async getSettings(userId: string): Promise<AccountSettings | null> {
    const user = await this.db.query.users.findFirst({
      columns: {
        id: true,
        email: true,
        handle: true,
        displayName: true,
        avatarUrl: true,
        bio: true,
        defaultProvider: true,
        defaultModelId: true,
        onboardingCompletedAt: true,
      },
      where: and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)),
    });
    if (!user) return null;
    const keyRows = await this.db
      .select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.userId, userId));
    return rowToSettings(user, keyRows.filter((k) => isByokProvider(k.provider)).map(rowToKey));
  }

  async updateProfile(userId: string, input: UpdateProfileInput): Promise<AccountSettings | null> {
    const patch: Partial<typeof schema.users.$inferInsert> = {};
    if (input.displayName !== undefined) patch.displayName = input.displayName;
    if (input.bio !== undefined) patch.bio = input.bio;
    if (input.avatarUrl !== undefined) patch.avatarUrl = input.avatarUrl;

    if (Object.keys(patch).length > 0) {
      await this.db
        .update(schema.users)
        .set(patch)
        .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)));
    }
    return this.getSettings(userId);
  }

  async saveProvider(userId: string, input: SaveProviderInput): Promise<AccountSettings | null> {
    const patch: Partial<typeof schema.users.$inferInsert> = {
      defaultProvider: input.provider,
      defaultModelId: input.modelId,
    };
    if (input.markOnboardingComplete) {
      patch.onboardingCompletedAt = new Date();
    }
    await this.db
      .update(schema.users)
      .set(patch)
      .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)));
    return this.getSettings(userId);
  }

  async saveApiKey(userId: string, input: SaveApiKeyInput): Promise<SavedProviderKey> {
    const [row] = await this.db
      .insert(schema.apiKeys)
      .values({
        userId,
        provider: input.provider,
        ciphertext: input.ciphertext,
        last4: input.last4,
      })
      .onConflictDoUpdate({
        target: [schema.apiKeys.userId, schema.apiKeys.provider],
        set: {
          ciphertext: input.ciphertext,
          last4: input.last4,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!row) throw new Error('api key upsert returned no row');
    return rowToKey(row);
  }

  async deleteApiKey(userId: string, provider: ByokProvider): Promise<void> {
    await this.db
      .delete(schema.apiKeys)
      .where(and(eq(schema.apiKeys.userId, userId), eq(schema.apiKeys.provider, provider)));
  }
}

export class InMemoryAccountRepo implements AccountRepo {
  private readonly users = new Map<string, Omit<AccountSettings, 'keys'> & { keys?: never }>();
  private readonly keys = new Map<string, SavedProviderKey>();

  constructor(seed?: AccountSettings[]) {
    for (const settings of seed ?? []) {
      this.users.set(settings.userId, {
        userId: settings.userId,
        email: settings.email,
        handle: settings.handle,
        displayName: settings.displayName,
        avatarUrl: settings.avatarUrl,
        bio: settings.bio,
        defaultProvider: settings.defaultProvider,
        defaultModelId: settings.defaultModelId,
        onboardingCompletedAt: settings.onboardingCompletedAt,
      });
      for (const key of settings.keys) this.keys.set(`${settings.userId}:${key.provider}`, key);
    }
  }

  ensureUser(userId: string, handle = userId): void {
    if (this.users.has(userId)) return;
    this.users.set(userId, {
      userId,
      email: `${handle}@playforge.local`,
      handle,
      displayName: handle,
      avatarUrl: null,
      bio: null,
      defaultProvider: 'platform',
      defaultModelId: null,
      onboardingCompletedAt: null,
    });
  }

  async getSettings(userId: string): Promise<AccountSettings | null> {
    const user = this.users.get(userId);
    if (!user) return null;
    return {
      ...user,
      keys: BYOK_PROVIDERS.flatMap((provider) => {
        const key = this.keys.get(`${userId}:${provider}`);
        return key ? [key] : [];
      }),
    };
  }

  async updateProfile(userId: string, input: UpdateProfileInput): Promise<AccountSettings | null> {
    const user = this.users.get(userId);
    if (!user) return null;
    this.users.set(userId, {
      ...user,
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.bio !== undefined ? { bio: input.bio } : {}),
      ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
    });
    return this.getSettings(userId);
  }

  async saveProvider(userId: string, input: SaveProviderInput): Promise<AccountSettings | null> {
    const user = this.users.get(userId);
    if (!user) return null;
    this.users.set(userId, {
      ...user,
      defaultProvider: input.provider,
      defaultModelId: input.modelId,
      onboardingCompletedAt:
        input.markOnboardingComplete && user.onboardingCompletedAt === null
          ? new Date().toISOString()
          : user.onboardingCompletedAt,
    });
    return this.getSettings(userId);
  }

  async saveApiKey(userId: string, input: SaveApiKeyInput): Promise<SavedProviderKey> {
    const existing = this.keys.get(`${userId}:${input.provider}`);
    const now = new Date().toISOString();
    const key: SavedProviderKey = {
      id: existing?.id ?? randomUUID(),
      provider: input.provider,
      ciphertext: input.ciphertext,
      last4: input.last4,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.keys.set(`${userId}:${input.provider}`, key);
    return key;
  }

  async deleteApiKey(userId: string, provider: ByokProvider): Promise<void> {
    this.keys.delete(`${userId}:${provider}`);
  }
}
