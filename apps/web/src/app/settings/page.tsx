'use client';

import {
  type AccountProvider,
  type AccountSettingsResponse,
  connectClaude,
  connectCodex,
  deleteAccountProvider,
  disconnectClaude,
  disconnectCodex,
  getAccountSettings,
  saveAccountProvider,
  updateAccountProfile,
} from '@/lib/api';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

const MODEL_OPTIONS: Record<AccountProvider, string[]> = {
  platform: [],
  anthropic: ['claude-sonnet-4-6', 'claude-opus-4-1'],
  openai: ['gpt-5.5', 'gpt-4.1'],
  'claude-subscription': [],
  'codex-subscription': [],
};

function isSubscriptionProvider(
  p: AccountProvider,
): p is 'claude-subscription' | 'codex-subscription' {
  return p === 'claude-subscription' || p === 'codex-subscription';
}

// One interactive color (signal) — selection is a state, not a provider-brand
// moment (identity board: signal cyan is rationed).
function providerBorder(_provider: AccountProvider, selected: boolean): string {
  return selected ? 'border-signal bg-raised' : 'border-hairline bg-surface';
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
    <main className="min-h-dvh bg-ground px-4 py-10 md:py-14">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-hairline pb-5">
          <div>
            <p className="type-label text-ink-4">Account</p>
            <h1 className="type-display mt-3 text-3xl text-ink sm:text-4xl">Settings</h1>
          </div>
          {settings && (
            <Link
              href={`/u/${settings.user.handle}`}
              className="border border-edge px-4 py-3 text-sm font-semibold text-ink transition-colors hover:border-signal hover:text-signal"
            >
              View public profile
            </Link>
          )}
        </header>

        {loading && <div className="text-sm text-ink-3">Loading settings…</div>}

        {!loading && (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]">
            <form
              onSubmit={saveProfile}
              className="space-y-5 border border-hairline bg-surface p-6"
            >
              <div>
                <h2 className="type-title text-lg text-ink">Profile</h2>
                {settings && (
                  <p className="mt-1.5 font-mono text-[11px] tracking-[.06em] text-ink-4">
                    @{settings.user.handle} · {settings.user.email}
                  </p>
                )}
              </div>

              <div>
                <label
                  htmlFor="displayName"
                  className="type-label-xs mb-2 block tracking-[.14em] text-ink-3"
                >
                  Display name
                </label>
                <input
                  id="displayName"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  disabled={disabled}
                  maxLength={80}
                  className="w-full border border-hairline bg-ground px-4 py-3 text-sm text-ink outline-none transition-colors focus:border-signal disabled:opacity-50"
                />
              </div>

              <div>
                <label
                  htmlFor="bio"
                  className="type-label-xs mb-2 block tracking-[.14em] text-ink-3"
                >
                  Bio
                </label>
                <textarea
                  id="bio"
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  disabled={disabled}
                  rows={5}
                  maxLength={280}
                  className="w-full resize-none border border-hairline bg-ground px-4 py-3 text-sm text-ink outline-none transition-colors placeholder:text-ink-4 focus:border-signal disabled:opacity-50"
                  placeholder="What do you like building?"
                />
              </div>

              <div>
                <label
                  htmlFor="avatarUrl"
                  className="type-label-xs mb-2 block tracking-[.14em] text-ink-3"
                >
                  Avatar URL
                </label>
                <input
                  id="avatarUrl"
                  type="url"
                  value={avatarUrl}
                  onChange={(e) => setAvatarUrl(e.target.value)}
                  disabled={disabled}
                  className="w-full border border-hairline bg-ground px-4 py-3 text-sm text-ink outline-none transition-colors placeholder:text-ink-4 focus:border-signal disabled:opacity-50"
                  placeholder="https://..."
                />
              </div>

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={disabled || displayName.trim().length === 0}
                  className="bg-signal px-5 py-3 text-sm font-bold text-chrome transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {savingProfile ? 'Saving…' : 'Save profile'}
                </button>
              </div>
            </form>

            <form
              onSubmit={saveProvider}
              className="space-y-5 border border-hairline bg-surface p-6"
            >
              <h2 className="type-title text-lg text-ink">Build provider</h2>

              <div className="grid gap-3">
                {(
                  [
                    'platform',
                    'anthropic',
                    'openai',
                    'claude-subscription',
                    'codex-subscription',
                  ] as AccountProvider[]
                ).map((option) => {
                  const meta = settings?.providers.find((item) => item.provider === option);
                  const selected = provider === option;
                  return (
                    <button
                      key={option}
                      type="button"
                      onClick={() => chooseProvider(option)}
                      disabled={disabled}
                      className={`border p-4 text-left transition-colors ${providerBorder(
                        option,
                        selected,
                      )} hover:border-signal disabled:cursor-not-allowed disabled:opacity-50`}
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span className="text-sm font-bold text-ink">{meta?.label ?? option}</span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          {/* Subscription credentials are harvested from a CLI login on the
                              machine running the API, so they only ever work in local dev. */}
                          {isSubscriptionProvider(option) && (
                            <span
                              title="Reads a CLI login from the machine running the API — local development only, never a deployed server."
                              className="border border-live px-2 py-1 font-mono text-[10px] uppercase tracking-[.12em] text-live"
                            >
                              Dev only
                            </span>
                          )}
                          {meta?.active && (
                            <span className="border border-hairline px-2 py-1 font-mono text-[10px] uppercase tracking-[.12em] text-ink-3">
                              Active
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="mt-2 block text-xs text-ink-4">
                        {option === 'platform'
                          ? 'Included credits'
                          : isSubscriptionProvider(option)
                            ? meta?.configured
                              ? 'Connected'
                              : 'Not connected'
                            : meta?.configured
                              ? `Saved key ending ${meta.last4}`
                              : 'No key saved'}
                      </span>
                    </button>
                  );
                })}
              </div>

              {isSubscriptionProvider(provider) && (
                <SubscriptionConnect
                  provider={provider}
                  connected={activeProvider?.configured ?? false}
                  disabled={disabled}
                  onChanged={() => {
                    void getAccountSettings()
                      .then(setSettings)
                      .catch(() => {
                        /* best-effort refresh */
                      });
                  }}
                />
              )}

              {provider !== 'platform' && !isSubscriptionProvider(provider) && (
                <div className="space-y-4">
                  <div>
                    <label
                      htmlFor="apiKey"
                      className="type-label-xs mb-2 block tracking-[.14em] text-ink-3"
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
                      className="w-full border border-hairline bg-ground px-4 py-3 text-sm text-ink outline-none transition-colors placeholder:text-ink-4 focus:border-signal disabled:opacity-50"
                    />
                    {activeProvider?.keyHelpUrl && (
                      <a
                        href={activeProvider.keyHelpUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-block text-xs text-signal hover:text-signal-bright"
                      >
                        Get a key
                      </a>
                    )}
                  </div>

                  <div>
                    <label
                      htmlFor="model"
                      className="type-label-xs mb-2 block tracking-[.14em] text-ink-3"
                    >
                      Model
                    </label>
                    <select
                      id="model"
                      value={modelId}
                      onChange={(e) => setModelId(e.target.value)}
                      disabled={disabled}
                      className="w-full border border-hairline bg-ground px-3 py-3 text-sm text-ink outline-none transition-colors focus:border-signal disabled:opacity-50"
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
                    className="type-label-xs mb-2 block tracking-[.14em] text-ink-3"
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
                    className="w-full border border-hairline bg-ground px-4 py-3 font-mono text-sm text-ink-3"
                  />
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3">
                {provider !== 'platform' &&
                !isSubscriptionProvider(provider) &&
                activeProvider?.configured ? (
                  <button
                    type="button"
                    onClick={() => removeKey(provider as 'anthropic' | 'openai')}
                    disabled={disabled}
                    className="px-4 py-3 text-sm font-semibold text-fail transition-colors hover:bg-fail/10 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Remove key
                  </button>
                ) : (
                  <span />
                )}
                <button
                  type="submit"
                  disabled={disabled}
                  className="bg-signal px-5 py-3 text-sm font-bold text-chrome transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {savingProvider ? 'Saving…' : 'Save provider'}
                </button>
              </div>
            </form>
          </div>
        )}

        {notice && (
          <div className="border border-pass/40 bg-pass/10 px-4 py-3 text-sm text-pass">
            {notice}
          </div>
        )}
        {errorMsg && (
          <div className="border border-fail/40 bg-fail/10 px-4 py-3 text-sm text-fail">
            {errorMsg}
          </div>
        )}
      </div>
    </main>
  );
}

function SubscriptionConnect({
  provider,
  connected,
  disabled,
  onChanged,
}: {
  provider: 'claude-subscription' | 'codex-subscription';
  connected: boolean;
  disabled: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const isClaude = provider === 'claude-subscription';

  const run = async (action: 'connect' | 'reauth' | 'disconnect') => {
    setBusy(true);
    setErr('');
    try {
      if (action === 'disconnect') await (isClaude ? disconnectClaude() : disconnectCodex());
      else
        await (isClaude ? connectClaude(action === 'reauth') : connectCodex(action === 'reauth'));
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-3">
        {isClaude
          ? 'Runs on your Claude Code subscription — the real Anthropic API, your prompt, billed to the subscription. Reads the local Claude Code login on this machine.'
          : 'Runs on your ChatGPT/Codex subscription — the real OpenAI Codex API, your prompt, billed to the subscription. Reads the local codex CLI login on this machine.'}
      </p>
      <p className="border border-live/40 bg-live/5 px-3 py-2 text-xs leading-relaxed text-live">
        <span className="font-semibold">Local development only.</span> The credential is harvested
        from the {isClaude ? 'Claude Code' : 'codex CLI'} login on the machine running the API
        {isClaude ? ' (macOS keychain only)' : ''}, and refreshing re-reads that same local login.
        On a deployed server there is nothing to read, so connecting will fail — use an API key
        instead.
      </p>
      <div className="flex flex-wrap gap-2">
        {!connected && (
          <button
            type="button"
            disabled={busy || disabled}
            onClick={() => run('connect')}
            className="bg-signal px-4 py-3 text-sm font-bold text-chrome transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        )}
        {connected && (
          <>
            <button
              type="button"
              disabled={busy || disabled}
              onClick={() => run('reauth')}
              className="border border-signal px-4 py-3 text-sm font-semibold text-signal transition-colors hover:bg-raised disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? 'Re-authing…' : 'Re-auth'}
            </button>
            <button
              type="button"
              disabled={busy || disabled}
              onClick={() => run('disconnect')}
              className="border border-hairline px-4 py-3 text-sm text-ink-3 transition-colors hover:border-edge hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
            >
              Disconnect
            </button>
          </>
        )}
      </div>
      {err && <p className="text-sm text-fail">{err}</p>}
    </div>
  );
}
