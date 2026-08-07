'use client';

import { BrandMark, Wordmark } from '@/components/Logo';
import {
  type AccountProvider,
  type AccountSettingsResponse,
  createProject,
  generateGame,
  getAccountSettings,
  saveAccountProvider,
} from '@/lib/api';
import { deriveProjectName, takePendingPrompt } from '@/lib/pending-prompt';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';

const MODEL_OPTIONS: Record<AccountProvider, string[]> = {
  platform: [],
  anthropic: ['claude-sonnet-4-6', 'claude-opus-4-1'],
  openai: ['gpt-5.5', 'gpt-4.1'],
  'claude-subscription': [],
  'codex-subscription': [],
};

// One interactive color (signal) — a selected card is not a provider-brand
// moment, it's a selection state (identity board: signal is rationed).
function providerAccent(_provider: AccountProvider): string {
  return 'border-signal bg-raised';
}

function OnboardingForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [settings, setSettings] = useState<AccountSettingsResponse | null>(null);
  const [provider, setProvider] = useState<AccountProvider>('platform');
  const [modelId, setModelId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState<'loading' | 'idle' | 'saving' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    let cancelled = false;
    void getAccountSettings()
      .then((data) => {
        if (cancelled) return;
        setSettings(data);
        setProvider(data.defaultProvider);
        setModelId(data.defaultModelId);
        setStatus('idle');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatus('error');
        setErrorMsg(err instanceof Error ? err.message : 'Could not load account settings');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const activeProvider = useMemo(
    () => settings?.providers.find((item) => item.provider === provider) ?? null,
    [provider, settings],
  );

  function chooseProvider(nextProvider: AccountProvider) {
    setProvider(nextProvider);
    const serverDefault = settings?.providers.find((item) => item.provider === nextProvider);
    const firstModel = MODEL_OPTIONS[nextProvider][0];
    setModelId(serverDefault?.defaultModelId ?? firstModel ?? '');
    setErrorMsg('');
    if (status === 'error') setStatus('idle');
  }

  async function continueAfterSave() {
    const pending = takePendingPrompt();
    if (pending) {
      const { project } = await createProject(deriveProjectName(pending), 'phaser');
      const { runId } = await generateGame(project.id, pending);
      router.push(`/projects/${project.id}?runId=${runId}`);
      return;
    }
    const next = searchParams.get('next');
    router.push(next && next !== 'build' ? next : '/');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('saving');
    setErrorMsg('');
    try {
      const needsKey = provider !== 'platform' && activeProvider?.configured !== true;
      if (needsKey && apiKey.trim().length === 0) {
        setStatus('error');
        setErrorMsg('Add an API key to use this provider.');
        return;
      }
      await saveAccountProvider({
        provider,
        modelId: modelId || undefined,
        apiKey: apiKey.trim() || undefined,
        completeOnboarding: true,
      });
      await continueAfterSave();
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'Setup failed');
    }
  }

  const disabled = status === 'loading' || status === 'saving';
  const modelOptions = MODEL_OPTIONS[provider];

  return (
    <main className="min-h-dvh safe-bottom bg-void px-4 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
        <header className="flex items-center justify-between">
          <Link href="/" className="inline-flex items-center gap-2.5">
            <BrandMark size={32} />
            <Wordmark className="text-lg text-ink" />
          </Link>
          <Link href="/" className="text-sm text-ink-4 hover:text-ink">
            Later
          </Link>
        </header>

        <section className="space-y-3">
          <p className="type-label text-ink-4">Account setup</p>
          <h1 className="type-display text-3xl text-ink sm:text-4xl">
            Choose your builder provider
          </h1>
          <p className="max-w-2xl text-sm leading-6 text-ink-3">
            Use included credits, or connect Claude or OpenAI with your own key.
          </p>
        </section>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {(['platform', 'anthropic', 'openai'] as AccountProvider[]).map((option) => {
              const meta = settings?.providers.find((item) => item.provider === option);
              const selected = provider === option;
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => chooseProvider(option)}
                  disabled={disabled}
                  className={`min-h-28 border p-4 text-left transition-colors ${
                    selected ? providerAccent(option) : 'border-hairline bg-surface'
                  } hover:border-signal disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  <span className="block text-sm font-bold text-ink">{meta?.label ?? option}</span>
                  <span className="mt-3 block font-mono text-[10px] tracking-[.12em] text-ink-4 uppercase">
                    {option === 'platform'
                      ? 'Included'
                      : meta?.configured
                        ? `Saved key ending ${meta.last4}`
                        : 'API key'}
                  </span>
                </button>
              );
            })}
          </div>

          {provider !== 'platform' && (
            <div className="grid gap-4 border border-hairline bg-ground p-5 sm:grid-cols-[1fr_180px]">
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
                  className="w-full border border-hairline bg-surface px-4 py-3 text-sm text-ink outline-none transition-colors placeholder:text-ink-4 focus:border-signal disabled:opacity-50"
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
                  className="w-full border border-hairline bg-surface px-3 py-3 text-sm text-ink outline-none transition-colors focus:border-signal disabled:opacity-50"
                >
                  {modelOptions.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {provider === 'platform' && (
            <div className="border border-hairline bg-ground p-5">
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
                className="w-full border border-hairline bg-surface px-4 py-3 font-mono text-sm text-ink-3"
              />
            </div>
          )}

          {status === 'error' && errorMsg && (
            <div className="border border-fail/40 bg-fail/10 px-4 py-3 text-sm text-fail">
              {errorMsg}
            </div>
          )}

          <div className="flex items-center justify-end gap-3">
            <Link
              href="/"
              className="px-4 py-3 text-sm font-semibold text-ink-3 transition-colors hover:text-ink sm:py-2.5"
            >
              Skip
            </Link>
            <button
              type="submit"
              disabled={disabled}
              className="bg-signal px-6 py-3 text-sm font-bold text-chrome transition-colors hover:bg-signal-bright disabled:cursor-not-allowed disabled:opacity-40 sm:py-2.5"
            >
              {status === 'saving' ? 'Saving…' : 'Continue'}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}

export default function OnboardingPage() {
  return (
    <Suspense>
      <OnboardingForm />
    </Suspense>
  );
}
