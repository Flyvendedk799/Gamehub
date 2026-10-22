/**
 * Google Antigravity ("agy") subscription → pi-ai stream.
 *
 * A personal Google AI subscription does not speak the public
 * `generativelanguage.googleapis.com` wire. It talks to Cloud Code
 * (`daily-cloudcode-pa.googleapis.com/v1internal`), which wraps the usual Gemini request as
 * `{ model, project, request }`, authenticates with `Authorization: Bearer`, and answers
 * `:streamGenerateContent?alt=sse` frames wrapped as `{ response: … }`. The request shape, host
 * choice, model-id mapping and tool-schema sanitising all live in `@flyvendedk799/ai-auth`
 * (ported from the openbot implementation that is verified against a real login); this file only
 * adapts that wire to pi-ai's `AssistantMessageEventStream` so the agent loop can use it like any
 * other provider.
 */
import {
  type CodeAssistContent,
  type CodeAssistContentPart,
  antigravityCliOptions,
  toCodeAssistRequest,
} from '@flyvendedk799/ai-auth';
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Message,
  type Model,
  type StopReason,
  type StreamOptions,
  type ToolCall,
  createAssistantMessageEventStream,
} from '@mariozechner/pi-ai';

export const ANTIGRAVITY_API = 'antigravity-cloudcode';
export const ANTIGRAVITY_PROVIDER = 'antigravity';
/**
 * `gemini-3.1-pro` maps to `gemini-3.1-pro-low`, which a personal login's Cloud Code model list
 * does not contain (every call 404s NOT_FOUND). The Gemini 3.8 Flash tiered id is the newest
 * model that list reliably carries; effort is a request setting, not part of the id.
 */
export const ANTIGRAVITY_DEFAULT_MODEL = 'gemini-3.8-flash-high';

/**
 * Header the caller uses to hand the (optional) GCP project through `Model.headers`. It is
 * consumed here and never sent upstream under this name; Cloud Code gets it as the body project
 * and, for personal projects only, `x-goog-user-project` (ai-auth strips the shared
 * `aicode-consumers` project from the header — it 403s there).
 */
export const ANTIGRAVITY_PROJECT_HEADER = 'x-playforge-antigravity-project';

/** Gemini 3 rejects a replayed function call that lacks the signature it was issued with. */
const SIGNATURE_PLACEHOLDER = 'skip_thought_signature_validator';

type Part = CodeAssistContentPart & { thoughtSignature?: string };

function toolResultText(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
}

/** pi-ai messages → Cloud Code contents. Consecutive tool results merge into one turn. */
export function toAntigravityContents(messages: Message[]): CodeAssistContent[] {
  const out: CodeAssistContent[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const parts: Part[] = [];
      if (typeof m.content === 'string') {
        if (m.content.length > 0) parts.push({ text: m.content });
      } else {
        for (const c of m.content) {
          if (c.type === 'text') parts.push({ text: c.text });
          else parts.push({ inlineData: { mimeType: c.mimeType, data: c.data } });
        }
      }
      if (parts.length === 0) parts.push({ text: ' ' });
      out.push({ role: 'user', parts });
    } else if (m.role === 'assistant') {
      const parts: Part[] = [];
      let firstCall = true;
      for (const c of m.content) {
        if (c.type === 'text' && c.text.length > 0) parts.push({ text: c.text });
        else if (c.type === 'toolCall') {
          const signature = c.thoughtSignature ?? (firstCall ? SIGNATURE_PLACEHOLDER : undefined);
          firstCall = false;
          parts.push({
            functionCall: { name: c.name, args: c.arguments },
            ...(signature ? { thoughtSignature: signature } : {}),
          });
        }
        // Thinking blocks are not replayed: Cloud Code does not accept them back.
      }
      if (parts.length > 0) out.push({ role: 'model', parts });
    } else {
      const part: Part = {
        functionResponse: {
          name: m.toolName,
          response: { result: toolResultText(m.content), ...(m.isError ? { error: true } : {}) },
        },
      };
      const last = out[out.length - 1];
      if (last?.role === 'user' && last.parts.every((p) => p.functionResponse !== undefined)) {
        last.parts.push(part);
      } else {
        out.push({ role: 'user', parts: [part] });
      }
    }
  }
  // Cloud Code rejects a request whose last turn is the model's ("Requests ending with a model
  // turn are not supported"). The agent can legitimately resume after its own text-only reply,
  // so close the gap with a neutral user turn rather than failing the run.
  if (out[out.length - 1]?.role === 'model') {
    out.push({ role: 'user', parts: [{ text: 'Continue.' }] });
  }
  return out;
}

/** Minimal SSE reader: yields each `data:` payload. */
async function* readSse(response: Response): AsyncGenerator<string> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload.length > 0 && payload !== '[DONE]') yield payload;
        }
        nl = buffer.indexOf('\n');
      }
    }
    const tail = buffer.replace(/\r$/, '');
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trim();
      if (payload.length > 0 && payload !== '[DONE]') yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}

interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
}

function emptyMessage(model: Model<string>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

/** pi-ai reasoning levels -> Cloud Code's three thinking tiers. */
function thinkingLevelFor(reasoning: string | undefined): 'low' | 'medium' | 'high' | undefined {
  switch (reasoning) {
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
    case 'xhigh':
      return 'high';
    default:
      return undefined;
  }
}

/**
 * Gemini counts its hidden thinking tokens against `maxOutputTokens`. A caller asking for a
 * short reply (the design interview: 3000) would otherwise spend the whole budget thinking and
 * return no text at all, so the visible-output budget is topped up to cover the thinking.
 */
const THINKING_HEADROOM_TOKENS = 8_192;

/** Appended to the system prompt when every turn must be a tool call. */
const TOOL_ONLY_PROTOCOL =
  '## Response protocol (mandatory)\n' +
  'Every response you give MUST be one or more tool calls. Never end a turn with prose, a plan, ' +
  'or a summary instead of a tool call: prose with no tool call ends the whole run immediately. ' +
  'Put any commentary inside the tool call itself. To finish, call the `done` tool.';
const MAX_OUTPUT_TOKENS = 65_536;

export type AntigravityStreamOptions = Pick<StreamOptions, 'apiKey' | 'signal' | 'maxTokens'> & {
  /** Caller's effort hint; only honoured on models whose effort is a request setting. */
  reasoning?: string;
  /**
   * 'any' makes the model answer with a function call instead of prose. Without it Gemini
   * often ends a turn with a plan written as text, which the agent loop reads as "finished".
   * Cloud Code accepts `toolConfig.functionCallingConfig` but IGNORES it (verified against a
   * live login: mode ANY still returned prose), so this is enforced in the system prompt,
   * which does work.
   */
  toolChoice?: 'any' | 'auto';
  /** Override for tests. */
  fetchImpl?: typeof fetch;
  /** Override for tests (backoff sleep). */
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/** Cloud Code answers these transiently (overload, restarts, per-minute quota). */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 20_000;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_DELAY_MS);
  const exp = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return exp / 2 + Math.random() * (exp / 2);
}

export function streamAntigravity(
  model: Model<string>,
  context: Context,
  options: AntigravityStreamOptions = {},
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const msg = emptyMessage(model);

  void (async () => {
    stream.push({ type: 'start', partial: msg });
    try {
      if (!options.apiKey) throw new Error('No Antigravity subscription connected.');
      const projectId = model.headers?.[ANTIGRAVITY_PROJECT_HEADER] || undefined;
      const cli = antigravityCliOptions({
        accessToken: options.apiKey,
        refreshToken: null,
        expiresAt: 0,
        email: null,
        projectId: projectId ?? null,
      });
      const forceTools =
        options.toolChoice === 'any' && context.tools !== undefined && context.tools.length > 0;
      const systemInstruction = forceTools
        ? `${context.systemPrompt ?? ''}${context.systemPrompt ? '\n\n' : ''}${TOOL_ONLY_PROTOCOL}`
        : context.systemPrompt;
      const body = toCodeAssistRequest(model.id, toAntigravityContents(context.messages), {
        ...(projectId ? { projectId } : {}),
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(context.tools && context.tools.length > 0
          ? {
              tools: context.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              })),
            }
          : {}),
      });
      // Game files are large; do not inherit the endpoint's small default output cap.
      const tier = thinkingLevelFor(options.reasoning);
      const existing = body.request.generationConfig;
      Object.assign(body.request, {
        generationConfig: {
          ...existing,
          // Only a model that already carries a thinking level (the tiered Flash) accepts one.
          ...(tier && existing?.thinkingConfig ? { thinkingConfig: { thinkingLevel: tier } } : {}),
          maxOutputTokens: Math.min(
            (options.maxTokens ?? MAX_OUTPUT_TOKENS) + THINKING_HEADROOM_TOKENS,
            MAX_OUTPUT_TOKENS,
          ),
        },
      });

      // Nothing has been emitted to the consumer until a response is accepted, so retrying the
      // request itself is safe — unlike a mid-stream failure, which would replay partial output.
      const doFetch = options.fetchImpl ?? fetch;
      const sleep = options.sleepImpl ?? defaultSleep;
      let response!: Response;
      for (let attempt = 0; ; attempt++) {
        let failure: { status: number; text: string; retryAfter: string | null } | null = null;
        try {
          response = await doFetch(`${cli.baseURL}:streamGenerateContent?alt=sse`, {
            method: 'POST',
            headers: cli.defaultHeaders as Record<string, string>,
            body: JSON.stringify(body),
            ...(options.signal ? { signal: options.signal } : {}),
          });
          if (response.ok) break;
          failure = {
            status: response.status,
            text: await response.text().catch(() => ''),
            retryAfter: response.headers.get('retry-after'),
          };
        } catch (netErr) {
          // A dropped connection before any response is as transient as a 503.
          if (options.signal?.aborted || attempt + 1 >= MAX_ATTEMPTS) throw netErr;
          await sleep(retryDelayMs(attempt, null), options.signal);
          continue;
        }
        if (!RETRYABLE_STATUS.has(failure.status) || attempt + 1 >= MAX_ATTEMPTS) {
          throw Object.assign(new Error(`Antigravity error: ${failure.status} ${failure.text}`), {
            status: failure.status,
          });
        }
        await sleep(retryDelayMs(attempt, failure.retryAfter), options.signal);
        if (options.signal?.aborted) throw new Error('aborted');
      }

      let textIndex = -1;
      let usage: UsageMetadata | undefined;
      let finishReason: string | undefined;
      let sawToolCall = false;

      const closeText = () => {
        if (textIndex === -1) return;
        const block = msg.content[textIndex];
        if (block?.type === 'text') {
          stream.push({
            type: 'text_end',
            contentIndex: textIndex,
            content: block.text,
            partial: msg,
          });
        }
        textIndex = -1;
      };

      for await (const payload of readSse(response)) {
        let frame: { response?: unknown } & Record<string, unknown>;
        try {
          frame = JSON.parse(payload) as typeof frame;
        } catch {
          continue; // keep-alive or partial line
        }
        const inner = (frame.response ?? frame) as {
          candidates?: Array<{
            content?: { parts?: Array<Part & { thought?: boolean }> };
            finishReason?: string;
          }>;
          usageMetadata?: UsageMetadata;
        };
        if (inner.usageMetadata?.totalTokenCount) usage = inner.usageMetadata;
        const candidate = inner.candidates?.[0];
        if (candidate?.finishReason) finishReason = candidate.finishReason;
        for (const part of candidate?.content?.parts ?? []) {
          if (part.thought) continue; // reasoning summaries are not part of the reply
          if (typeof part.text === 'string' && part.text.length > 0) {
            if (textIndex === -1) {
              msg.content.push({ type: 'text', text: '' });
              textIndex = msg.content.length - 1;
              stream.push({ type: 'text_start', contentIndex: textIndex, partial: msg });
            }
            const block = msg.content[textIndex];
            if (block?.type === 'text') block.text += part.text;
            stream.push({
              type: 'text_delta',
              contentIndex: textIndex,
              delta: part.text,
              partial: msg,
            });
          }
          if (part.functionCall) {
            closeText();
            sawToolCall = true;
            const call: ToolCall = {
              type: 'toolCall',
              id: `call_${msg.content.length}_${part.functionCall.name}`,
              name: part.functionCall.name,
              arguments: (part.functionCall.args ?? {}) as Record<string, unknown>,
              ...(part.thoughtSignature ? { thoughtSignature: String(part.thoughtSignature) } : {}),
            };
            msg.content.push(call);
            const idx = msg.content.length - 1;
            // Function calls arrive whole, never in pieces.
            stream.push({ type: 'toolcall_start', contentIndex: idx, partial: msg });
            stream.push({ type: 'toolcall_end', contentIndex: idx, toolCall: call, partial: msg });
          }
        }
      }
      closeText();

      if (usage) {
        const cached = usage.cachedContentTokenCount ?? 0;
        msg.usage.input = Math.max(0, (usage.promptTokenCount ?? 0) - cached);
        msg.usage.cacheRead = cached;
        msg.usage.output = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
        msg.usage.totalTokens = usage.totalTokenCount ?? msg.usage.input + msg.usage.output;
      }
      const reason: Extract<StopReason, 'stop' | 'length' | 'toolUse'> = sawToolCall
        ? 'toolUse'
        : finishReason === 'MAX_TOKENS'
          ? 'length'
          : 'stop';
      msg.stopReason = reason;
      stream.push({ type: 'done', reason, message: msg });
      stream.end();
    } catch (err) {
      const aborted = options.signal?.aborted === true;
      msg.stopReason = aborted ? 'aborted' : 'error';
      msg.errorMessage = err instanceof Error ? err.message : String(err);
      stream.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: msg });
      stream.end();
    }
  })();

  return stream;
}
