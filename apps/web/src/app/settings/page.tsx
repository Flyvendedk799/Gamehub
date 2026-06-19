'use client';

import {
  type AccountProvider,
  type AccountSettingsResponse,
  type ClaudeSubscriptionStatus,
  connectClaude,
  deleteAccountProvider,
  disconnectClaude,
  getAccountSettings,
  getClaudeAuthStatus,
  saveAccountProvider,
  updateAccountProfile,
} from '@/lib/api';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

const MODEL_OPTIONS: Record<AccountProvider, string[]> = {
  platform: [],
  anthropic: ['claude-sonnet-4-6', 'claude-opus-4-1'],
  openai: ['gpt-4o', 'gpt-4.1'],
};

function providerBorder(provider: AccountProvider, selected: boolean): string {
  if (!selected) return 'border-[#222222] bg-[#111111]';
  if (provider === 'anthropic') return 'border-[#f59e0b] bg-[#f59e0b]/10';
  if (provider === 'openai') return 'border-[#22c55e] bg-[#22c55e]/10';
  return 'border-[#6366f1] bg-[#6366f1]/10';
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<AccountSettingsResponse | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [provider, setProvider] = useState<AccountProvider>('platform');
  const [modelId, setModelId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let cancelled = false;
    void getAccountSettings()
      .then((data) => {
        if (cancelled) return;
        hydrate(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setErrorMsg(err instanceof Error ? err.message : 'Could not load settings');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const activeProvider = useMemo(
    () => settings?.providers.find((item) => item.provider === provider) ?? null,
    [provider, settings],
  );

  function hydrate(data: AccountSettingsResponse) {
    setSettings(data);
    setDisplayName(data.user.displayName);
    setBio(data.user.bio ?? '');
    setAvatarUrl(data.user.avatarUrl ?? '');
    setProvider(data.defaultProvider);
    setModelId(data.defaultModelId);
    setApiKey('');
  }

  function chooseProvider(nextProvider: AccountProvider) {
    setProvider(nextProvider);
    const meta = settings?.providers.find((item) => item.provider === nextProvider);
    setModelId(meta?.defaultModelId ?? MODEL_OPTIONS[nextProvider][0] ?? '');
    setApiKey('');
    setErrorMsg('');
    setNotice('');
  }

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSavingProfile(true);
    setErrorMsg('');
    setNotice('');
    try {
      const data = await updateAccountProfile({ displayName, bio, avatarUrl });
      hydrate(data);
      setNotice('Profile saved.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not save profile');
    } finally {
      setSavingProfile(false);
    }
  }

  async function saveProvider(e: React.FormEvent) {
    e.preventDefault();
    setSavingProvider(true);
    setErrorMsg('');
    setNotice('');
    try {
      const needsKey = provider !== 'platform' && activeProvider?.configured !== true;
      if (needsKey && apiKey.trim().length === 0) {
        setErrorMsg('Add an API key to use this provider.');
        return;
      }
      const data = await saveAccountProvider({
        provider,
        modelId: modelId || undefined,
        apiKey: apiKey.trim() || undefined,
        completeOnboarding: true,
      });
      hydrate(data);
      setNotice('Provider saved.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not save provider');
    } finally {
      setSavingProvider(false);
    }
  }

  async function removeKey(providerToDelete: Exclude<AccountProvider, 'platform'>) {
    setSavingProvider(true);
    setErrorMsg('');
    setNotice('');
    try {
      const data = await deleteAccountProvider(providerToDelete);
      hydrate(data);
      setNotice('API key removed.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not remove key');
    } finally {
      setSavingProvider(false);
    }
  }

  const disabled = loading || savingProfile || savingProvider;

  return (
    <main className="min-h-screen bg-[#0a0a0a] px-4 py-10">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-[#818cf8]">Account</p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-[#f4f4f5]">Settings</h1>
          </div>
          {settings && (
            <Link
              href={`/u/${settings.user.handle}`}
              className="rounded-lg border border-[#222222] px-4 py-2 text-sm text-[#a1a1aa] hover:border-[#6366f1] hover:text-[#f4f4f5]"
            >
              View public profile
            </Link>
          )}
        </header>

        {loading && <div className="text-sm text-[#71717a]">Loading settings...</div>}

        {!loading && (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]">
            <form
              onSubmit={saveProfile}
              className="space-y-5 rounded-lg border border-[#222222] bg-[#111111] p-6"
            >
              <div>
                <h2 className="text-lg font-semibold text-[#f4f4f5]">Profile</h2>
                {settings && (
                  <p className="mt-1 text-sm text-[#71717a]">
                    @{settings.user.handle} / {settings.user.email}
                  </p>
                )}
              </div>

              <div>
                <label
                  htmlFor="displayName"
                  className="mb-1.5 block text-sm font-medium text-[#a1a1aa]"
                >
                  Display name
                </label>
                <input
                  id="displayName"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  disabled={disabled}
                  maxLength={80}
                  className="w-full rounded-lg border border-[#222222] bg-[#0a0a0a] px-4 py-3 text-sm text-[#f4f4f5] outline-none transition-colors focus:border-[#6366f1] disabled:opacity-50"
                />
              </div>

              <div>
                <label htmlFor="bio" className="mb-1.5 block text-sm font-medium text-[#a1a1aa]">
                  Bio
                </label>
                <textarea
                  id="bio"
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  disabled={disabled}
                  rows={5}
                  maxLength={280}
                  className="w-full resize-none rounded-lg border border-[#222222] bg-[#0a0a0a] px-4 py-3 text-sm text-[#f4f4f5] outline-none transition-colors placeholder:text-[#52525b] focus:border-[#6366f1] disabled:opacity-50"
                  placeholder="What do you like building?"
                />
              </div>

              <div>
                <label
                  htmlFor="avatarUrl"
                  className="mb-1.5 block text-sm font-medium text-[#a1a1aa]"
                >
                  Avatar URL
                </label>
                <input
                  id="avatarUrl"
                  type="url"
                  value={avatarUrl}
                  onChange={(e) => setAvatarUrl(e.target.value)}
                  disabled={disabled}
                  className="w-full rounded-lg border border-[#222222] bg-[#0a0a0a] px-4 py-3 text-sm text-[#f4f4f5] outline-none transition-colors placeholder:text-[#52525b] focus:border-[#6366f1] disabled:opacity-50"
                  placeholder="https://..."
                />
              </div>

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={disabled || displayName.trim().length === 0}
                  className="rounded-lg bg-[#6366f1] px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-indigo-500/20 transition-colors hover:bg-[#4f46e5] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {savingProfile ? 'Saving...' : 'Save profile'}
                </button>
              </div>
            </form>

            <form
              onSubmit={saveProvider}
              className="space-y-5 rounded-lg border border-[#222222] bg-[#111111] p-6"
            >
              <h2 className="text-lg font-semibold text-[#f4f4f5]">Build provider</h2>

              <div className="grid gap-3">
                {(['platform', 'anthropic', 'openai'] as AccountProvider[]).map((option) => {
                  const meta = settings?.providers.find((item) => item.provider === option);
                  const selected = provider === option;
                  return (
                    <button
                      key={option}
                      type="button"
                      onClick={() => chooseProvider(option)}
                      disabled={disabled}
                      className={`rounded-lg border p-4 text-left transition-all ${providerBorder(
                        option,
                        selected,
                      )} hover:border-[#818cf8] disabled:cursor-not-allowed disabled:opacity-50`}
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span className="text-sm font-semibold text-[#f4f4f5]">
                          {meta?.label ?? option}
                        </span>
                        {meta?.active && (
                          <span className="rounded-md bg-[#0a0a0a] px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-[#a1a1aa]">
                            Active
                          </span>
                        )}
                      </span>
                      <span className="mt-2 block text-xs text-[#71717a]">
                        {option === 'platform'
                          ? 'Included credits'
                          : meta?.configured
                            ? `Saved key ending ${meta.last4}`
                            : 'No key saved'}
                      </span>
                    </button>
                  );
                })}
              </div>

              {provider !== 'platform' && (
                <div className="space-y-4">
                  <div>
                    <label
                      htmlFor="apiKey"
                      className="mb-1.5 block text-sm font-medium text-[#a1a1aa]"
                    >
                      API key
                    </label>
                    <input
                      id="apiKey"
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      disabled={disabled}
                      placeholder={
                        activeProvider?.configured && activeProvider.last4
                          ? `Saved key ending ${activeProvider.last4}`
                          : provider === 'anthropic'
                            ? 'sk-ant-...'
                            : 'sk-...'
                      }
                      className="w-full rounded-lg border border-[#222222] bg-[#0a0a0a] px-4 py-3 text-sm text-[#f4f4f5] outline-none transition-colors placeholder:text-[#52525b] focus:border-[#6366f1] disabled:opacity-50"
                    />
                    {activeProvider?.keyHelpUrl && (
                      <a
                        href={activeProvider.keyHelpUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-block text-xs text-[#818cf8] hover:text-[#a5b4fc]"
                      >
                        Get a key
                      </a>
                    )}
                  </div>

                  <div>
                    <label
                      htmlFor="model"
                      className="mb-1.5 block text-sm font-medium text-[#a1a1aa]"
                    >
                      Model
                    </label>
                    <select
                      id="model"
                      value={modelId}
                      onChange={(e) => setModelId(e.target.value)}
                      disabled={disabled}
                      className="w-full rounded-lg border border-[#222222] bg-[#0a0a0a] px-3 py-3 text-sm text-[#f4f4f5] outline-none transition-colors focus:border-[#6366f1] disabled:opacity-50"
                    >
                      {MODEL_OPTIONS[provider].map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {provider === 'platform' && (
                <div>
                  <label
                    htmlFor="platformModel"
                    className="mb-1.5 block text-sm font-medium text-[#a1a1aa]"
                  >
                    Model
                  </label>
                  <input
                    id="platformModel"
                    value={
                      settings?.providers.find((item) => item.provider === 'platform')
                        ?.defaultModelId ?? ''
                    }
                    disabled
                    className="w-full rounded-lg border border-[#222222] bg-[#0a0a0a] px-4 py-3 text-sm text-[#71717a]"
                  />
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3">
                {provider !== 'platform' && activeProvider?.configured ? (
                  <button
                    type="button"
                    onClick={() => removeKey(provider)}
                    disabled={disabled}
                    className="rounded-lg px-4 py-2.5 text-sm font-medium text-[#f87171] hover:bg-[#ef4444]/10 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Remove key
                  </button>
                ) : (
                  <span />
                )}
                <button
                  type="submit"
                  disabled={disabled}
                  className="rounded-lg bg-[#6366f1] px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-indigo-500/20 transition-colors hover:bg-[#4f46e5] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {savingProvider ? 'Saving...' : 'Save provider'}
                </button>
              </div>
            </form>
          </div>
        )}

        <ClaudeSubscriptionCard />

        {notice && (
          <div className="rounded-lg border border-[#22c55e]/20 bg-[#22c55e]/10 px-4 py-3 text-sm text-[#86efac]">
            {notice}
          </div>
        )}
        {errorMsg && (
          <div className="rounded-lg border border-[#ef4444]/20 bg-[#ef4444]/10 px-4 py-3 text-sm text-[#fca5a5]">
            {errorMsg}
          </div>
        )}
      </div>
    </main>
  );
}

function ClaudeSubscriptionCard() {
  const [status, setStatus] = useState<ClaudeSubscriptionStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let cancelled = false;
    void getClaudeAuthStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        /* status is best-effort */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const run = async (fn: () => Promise<ClaudeSubscriptionStatus>) => {
    setBusy(true);
    setErr('');
    try {
      setStatus(await fn());
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  const connected = status?.connected ?? false;
  const expires = status?.expiresAt ? new Date(status.expiresAt).toLocaleString() : null;

  return (
    <section className="space-y-4 rounded-lg border border-[#222222] bg-[#111111] p-6">
      <div>
        <h2 className="text-lg font-semibold text-[#f4f4f5]">Claude subscription</h2>
        <p className="text-sm text-[#a1a1aa]">
          Generate on your Claude Code subscription — the real Anthropic API, your prompt, billed to
          the subscription instead of a metered key. Reads the local Claude Code login on this
          machine.
        </p>
      </div>
      <div className="flex items-center gap-2 text-sm">
        <span
          className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-[#22c55e]' : 'bg-[#52525b]'}`}
        />
        {connected ? (
          <span className="text-[#86efac]">
            Connected
            {expires ? ` · token valid until ${expires}` : ''}
            {status?.canRefresh === false ? ' · re-auth to refresh' : ''}
          </span>
        ) : (
          <span className="text-[#a1a1aa]">Not connected</span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {!connected && (
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => connectClaude(false))}
            className="rounded-lg bg-[#f59e0b] px-4 py-2 text-sm font-medium text-[#1a1a1a] transition-colors hover:bg-[#d97706] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        )}
        {connected && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => connectClaude(true))}
              className="rounded-lg border border-[#f59e0b]/40 bg-[#f59e0b]/10 px-4 py-2 text-sm font-medium text-[#fbbf24] transition-colors hover:bg-[#f59e0b]/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? 'Re-authing…' : 'Re-auth'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => run(disconnectClaude)}
              className="rounded-lg border border-[#222222] px-4 py-2 text-sm text-[#a1a1aa] transition-colors hover:bg-[#1a1a1a] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Disconnect
            </button>
          </>
        )}
      </div>
      {err && <p className="text-sm text-[#fca5a5]">{err}</p>}
    </section>
  );
}
