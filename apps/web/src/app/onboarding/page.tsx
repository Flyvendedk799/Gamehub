'use client';

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

function providerAccent(provider: AccountProvider): string {
  if (provider === 'anthropic') return 'border-[#f59e0b] bg-[#f59e0b]/10';
  if (provider === 'openai') return 'border-[#22c55e] bg-[#22c55e]/10';
  return 'border-[#6366f1] bg-[#6366f1]/10';
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
    <main className="min-h-screen bg-[#0a0a0a] px-4 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
        <header className="flex items-center justify-between">
          <Link href="/" className="inline-flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#6366f1]">
              <svg width="16" height="16" viewBox="0 0 22 22" fill="none" aria-hidden="true">
                <polygon points="4,3 18,11 4,19" fill="white" />
              </svg>
            </div>
            <span className="text-lg font-semibold text-[#f4f4f5]">Playforge</span>
          </Link>
          <Link href="/" className="text-sm text-[#71717a] hover:text-[#f4f4f5]">
            Later
          </Link>
        </header>

        <section className="space-y-2">
          <p className="text-sm font-medium text-[#818cf8]">Account setup</p>
          <h1 className="text-3xl font-bold tracking-tight text-[#f4f4f5]">
            Choose your builder provider
          </h1>
          <p className="max-w-2xl text-sm leading-6 text-[#a1a1aa]">
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
                  className={`min-h-28 rounded-lg border p-4 text-left transition-all ${
                    selected ? providerAccent(option) : 'border-[#222222] bg-[#111111]'
                  } hover:border-[#818cf8] disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  <span className="block text-sm font-semibold text-[#f4f4f5]">
                    {meta?.label ?? option}
                  </span>
                  <span className="mt-3 block text-xs text-[#71717a]">
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
            <div className="grid gap-4 rounded-lg border border-[#222222] bg-[#111111] p-5 sm:grid-cols-[1fr_180px]">
              <div>
                <label htmlFor="apiKey" className="mb-1.5 block text-sm font-medium text-[#a1a1aa]">
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
                <label htmlFor="model" className="mb-1.5 block text-sm font-medium text-[#a1a1aa]">
                  Model
                </label>
                <select
                  id="model"
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  disabled={disabled}
                  className="w-full rounded-lg border border-[#222222] bg-[#0a0a0a] px-3 py-3 text-sm text-[#f4f4f5] outline-none transition-colors focus:border-[#6366f1] disabled:opacity-50"
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
            <div className="rounded-lg border border-[#222222] bg-[#111111] p-5">
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

          {status === 'error' && errorMsg && (
            <div className="rounded-lg border border-[#ef4444]/20 bg-[#ef4444]/10 px-4 py-3 text-sm text-[#fca5a5]">
              {errorMsg}
            </div>
          )}

          <div className="flex items-center justify-end gap-3">
            <Link
              href="/"
              className="rounded-lg px-4 py-2.5 text-sm font-medium text-[#a1a1aa] hover:bg-[#161616] hover:text-[#f4f4f5]"
            >
              Skip
            </Link>
            <button
              type="submit"
              disabled={disabled}
              className="rounded-lg bg-[#6366f1] px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-indigo-500/20 transition-colors hover:bg-[#4f46e5] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {status === 'saving' ? 'Saving...' : 'Continue'}
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
