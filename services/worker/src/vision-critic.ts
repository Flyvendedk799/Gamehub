import { type GenerateOptions, complete } from '@playforge/providers';
import type { ModelRef } from '@playforge/shared';
import type { VisionCriticFn } from './run-generation';

/** Auxiliary calls use the same routing and current credential as agent turns. */
export function makeVisionCritic(
  config: {
    model: ModelRef;
    options: GenerateOptions;
    getApiKey?: () => Promise<string>;
  },
  completion: typeof complete = complete,
): VisionCriticFn {
  return async ({ pngBase64, mimeType, prompt }) => {
    const result = await completion(config.model, [{ role: 'user', content: prompt }], {
      ...config.options,
      apiKey: config.getApiKey ? await config.getApiKey() : config.options.apiKey,
      maxTokens: 500,
      userImages: [{ data: pngBase64, mimeType }],
    });
    return result.content;
  };
}
