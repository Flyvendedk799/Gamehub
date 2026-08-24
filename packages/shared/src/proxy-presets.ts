import { z } from 'zod';

export const PROXY_PRESET_SCHEMA_VERSION = 1 as const;

export const PROXY_PRESETS = [
  {
    id: 'official-openai',
    label: 'OpenAI Official',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    notes: '',
  },
  {
    id: 'official-anthropic',
    label: 'Anthropic Official',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    notes: '',
  },
  {
    id: 'official-google',
    label: 'Google AI Studio',
    provider: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    notes: 'OpenAI-compatible endpoint',
  },
  {
    id: 'duckcoding',
    label: 'DuckCoding',
    provider: 'openai',
    baseUrl: 'https://api.duckcoding.ai/v1',
    notes: 'OpenAI compatible relay',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    provider: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    notes: 'Multi-model relay',
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    provider: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    notes: 'CN-friendly relay',
  },
  {
    id: 'one-api',
    label: 'one-api (self-hosted)',
    provider: 'openai',
    baseUrl: 'http://localhost:3000/v1',
    notes: 'Edit URL to your deployment',
  },
  {
    id: 'cli-proxy-api',
    label: 'CLIProxyAPI',
    provider: 'anthropic',
    baseUrl: 'http://127.0.0.1:8317',
    notes: '',
  },
  {
    id: 'subgate',
    label: 'SubGate',
    provider: 'openai',
    // Loopback default for a co-hosted gateway; point at the public hostname
    // when the consumer runs elsewhere. The API key is a SubGate consumer
    // token (sgk_…), not a provider key.
    baseUrl: 'http://127.0.0.1:8788/v1',
    notes: 'Self-hosted gateway. Edit URL to your deployment; key is a consumer token',
  },
  {
    id: 'subgate-anthropic',
    label: 'SubGate (Anthropic wire)',
    provider: 'anthropic',
    baseUrl: 'http://127.0.0.1:8788',
    notes: 'Same gateway via /v1/messages, for the Anthropic-native path',
  },
  {
    id: 'custom',
    label: 'Custom...',
    provider: 'openai',
    baseUrl: '',
    notes: 'Enter your own base URL',
  },
] as const;

export type ProxyPresetId = (typeof PROXY_PRESETS)[number]['id'];

const presetIds = PROXY_PRESETS.map((p) => p.id) as [ProxyPresetId, ...ProxyPresetId[]];
export const ProxyPresetIdSchema = z.enum(presetIds);

export const ProxyPreset = z.object({
  id: ProxyPresetIdSchema,
  label: z.string(),
  provider: z.string(),
  baseUrl: z.string(),
  notes: z.string(),
});
export type ProxyPreset = z.infer<typeof ProxyPreset>;

export function getPresetById(id: ProxyPresetId): (typeof PROXY_PRESETS)[number] | undefined {
  return PROXY_PRESETS.find((p) => p.id === id);
}
