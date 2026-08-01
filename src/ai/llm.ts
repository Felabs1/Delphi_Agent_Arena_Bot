/**
 * OpenRouter client.
 *
 * Deliberately small: one chat-completion call, JSON-parsed, with timeouts,
 * bounded retries, and a hard per-run spend ceiling. `fetch` is injectable so
 * the whole AI layer is testable without touching the network.
 *
 * The spend ceiling is not decoration. This agent runs on a cron for the length
 * of a competition; an unbounded retry loop against a frontier model is a way to
 * lose more money than the markets ever could.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export type FetchLike = (
  url: string,
  init: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface CompletionRequest {
  model: string;
  system: string;
  user: string;
  /**
   * Reasoning models spend this budget on hidden reasoning tokens before
   * emitting anything. Set too low, they return an empty string or truncate
   * mid-JSON — which looks like a parse bug but is a budget bug. The default is
   * generous for that reason.
   */
  maxTokens?: number;
  temperature?: number;
  /** Ask the provider to emit a JSON object. Ignored by models that lack it. */
  jsonMode?: boolean;
  /**
   * Cap hidden reasoning. We want a calibrated number, not an essay, and
   * reasoning tokens dominate both latency and cost on these models.
   */
  reasoningEffort?: "low" | "medium" | "high";
}

export interface CompletionResult {
  model: string;
  text: string;
  promptTokens: number;
  completionTokens: number;
  /** USD, as reported by OpenRouter. 0 when the provider omits it. */
  costUsd: number;
  latencyMs: number;
}

export class BudgetExceededError extends Error {
  constructor(spent: number, limit: number) {
    super(
      `LLM budget exhausted for this run: spent $${spent.toFixed(4)} of $${limit.toFixed(4)}`,
    );
    this.name = "BudgetExceededError";
  }
}

export interface OpenRouterOptions {
  apiKey: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  /** Hard ceiling on total spend for the lifetime of this client. */
  maxCostUsd?: number;
  /** OpenRouter attribution headers. */
  referer?: string;
  title?: string;
  sleep?: (ms: number) => Promise<void>;
}

export class OpenRouterClient {
  private spentUsd = 0;
  private callCount = 0;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxCostUsd: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: OpenRouterOptions) {
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.maxCostUsd = options.maxCostUsd ?? Infinity;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get spent(): number {
    return this.spentUsd;
  }
  get calls(): number {
    return this.callCount;
  }
  get budgetRemaining(): number {
    return this.maxCostUsd - this.spentUsd;
  }
  /** True when another call would be reckless. Check before batching work. */
  get exhausted(): boolean {
    return this.spentUsd >= this.maxCostUsd;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (this.exhausted) {
      throw new BudgetExceededError(this.spentUsd, this.maxCostUsd);
    }

    const body = {
      model: request.model,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      max_tokens: request.maxTokens ?? 4000,
      temperature: request.temperature ?? 0.2,
      // Ask OpenRouter to report actual cost so the budget is real, not modelled.
      usage: { include: true },
      ...(request.jsonMode ? { response_format: { type: "json_object" } } : {}),
      ...(request.reasoningEffort
        ? { reasoning: { effort: request.reasoningEffort } }
        : {}),
    };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const startedAt = Date.now();
      try {
        // The body read must sit INSIDE the timeout window. A slow model sends
        // headers promptly and then trickles the body; timing out only the
        // connection leaves `text()` able to hang forever and stall the cron.
        const { response, raw } = await this.withTimeout(async (signal) => {
          const res = await this.fetchImpl(OPENROUTER_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.options.apiKey}`,
              "Content-Type": "application/json",
              ...(this.options.referer
                ? { "HTTP-Referer": this.options.referer }
                : {}),
              ...(this.options.title ? { "X-Title": this.options.title } : {}),
            },
            body: JSON.stringify(body),
            signal,
          });
          return { response: res, raw: await res.text() };
        });

        if (!response.ok) {
          // 4xx other than rate limiting will not improve by trying again.
          if (
            response.status !== 429 &&
            response.status >= 400 &&
            response.status < 500
          ) {
            throw new NonRetryableError(
              `OpenRouter ${response.status} for ${request.model}: ${truncate(raw)}`,
            );
          }
          throw new Error(
            `OpenRouter ${response.status} for ${request.model}: ${truncate(raw)}`,
          );
        }

        const parsed = JSON.parse(raw) as OpenRouterResponse;
        // A 200 can still carry an error body.
        if (parsed.error) {
          throw new NonRetryableError(
            `OpenRouter error for ${request.model}: ${parsed.error.message}`,
          );
        }

        const choice = parsed.choices?.[0];
        const text = choice?.message?.content ?? "";
        const finishReason = choice?.finish_reason ?? "";

        // Hitting the token ceiling is deterministic: an identical retry burns
        // money and latency to fail the same way. Say what actually happened.
        if (finishReason === "length") {
          throw new NonRetryableError(
            `${request.model} hit the ${body.max_tokens}-token ceiling before finishing` +
              `${text.trim() ? " (output truncated)" : " (no content — reasoning consumed the budget)"}` +
              `. Raise maxTokens or lower reasoningEffort.`,
          );
        }
        if (!text.trim()) throw new Error(`empty completion from ${request.model}`);

        const costUsd = Number(parsed.usage?.cost ?? 0) || 0;
        this.spentUsd += costUsd;
        this.callCount += 1;

        return {
          model: parsed.model ?? request.model,
          text,
          promptTokens: parsed.usage?.prompt_tokens ?? 0,
          completionTokens: parsed.usage?.completion_tokens ?? 0,
          costUsd,
          latencyMs: Date.now() - startedAt,
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (lastError instanceof NonRetryableError) throw lastError;
        if (attempt === this.maxRetries) break;
        // Exponential backoff with jitter, so a rate limit doesn't resonate.
        const backoff = 2 ** attempt * 500 + Math.random() * 250;
        await this.sleep(backoff);
      }
    }

    throw new Error(
      `OpenRouter failed after ${this.maxRetries + 1} attempts for ${request.model}: ${lastError?.message}`,
    );
  }

  /** Complete and parse the result as JSON, tolerating fenced or prefixed output. */
  async completeJson<T>(
    request: CompletionRequest,
    validate: (value: unknown) => T,
  ): Promise<{ value: T; result: CompletionResult }> {
    const result = await this.complete({ ...request, jsonMode: true });
    const value = validate(parseJsonLoose(result.text));
    return { value, result };
  }

  /**
   * Races the whole operation against the deadline. `AbortSignal` alone is not
   * enough: a transport that ignores the signal (or a body that stalls without
   * erroring) would still hang, so the timer rejects independently.
   */
  private async withTimeout<T>(
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`request exceeded ${this.timeoutMs}ms timeout`));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([fn(controller.signal), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

class NonRetryableError extends Error {}

/**
 * Models wrap JSON in prose or code fences no matter how firmly you ask.
 * Try strict parsing, then the outermost brace-balanced object.
 */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }

  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(withoutFence);
  } catch {
    // fall through
  }

  const start = withoutFence.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < withoutFence.length; i++) {
      const ch = withoutFence[i]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          return JSON.parse(withoutFence.slice(start, i + 1));
        }
      }
    }
  }

  throw new Error(`could not parse JSON from model output: ${truncate(text)}`);
}

interface OpenRouterResponse {
  model?: string;
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message: string };
}

const truncate = (s: string, n = 300): string =>
  s.length <= n ? s : s.slice(0, n) + "…";
