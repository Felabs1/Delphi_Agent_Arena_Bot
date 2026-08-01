/**
 * The AI layer, with the network replaced by a scripted transport.
 * Nothing here makes a real call — that is `scripts/smoke-openrouter.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import {
  BudgetExceededError,
  OpenRouterClient,
  parseJsonLoose,
  type FetchLike,
} from "../src/ai/llm.js";
import {
  EnsembleEstimator,
  agreementScore,
  aggregate,
  isFreeModel,
  maxGap,
  parseModelChain,
  type ModelOpinion,
} from "../src/ai/ensemble.js";
import {
  MemoryEstimateCache,
  fingerprintMetadata,
  stalenessReason,
  type CachedEstimate,
} from "../src/ai/cache.js";
import { normalizeProbabilities } from "../src/ai/estimator.js";
import { FakeDelphi } from "../src/sdk/fake.js";
import type { Market } from "../src/sdk/port.js";

// ---------------------------------------------------------------- helpers

interface Scripted {
  body?: unknown;
  status?: number;
  cost?: number;
  /** Overrides `body`, for malformed/truncated output. */
  rawContent?: string;
  finishReason?: string;
}

function transport(script: Scripted[]): {
  fetchImpl: FetchLike;
  requests: { model: string; system: string; user: string }[];
} {
  const requests: { model: string; system: string; user: string }[] = [];
  let call = 0;
  const fetchImpl: FetchLike = async (_url, init) => {
    const parsed = JSON.parse(String(init.body)) as {
      model: string;
      messages: { role: string; content: string }[];
    };
    requests.push({
      model: parsed.model,
      system: parsed.messages[0]?.content ?? "",
      user: parsed.messages[1]?.content ?? "",
    });

    const step = script[Math.min(call, script.length - 1)]!;
    call++;
    const payload = {
      model: parsed.model,
      choices: [
        {
          message: {
            content: step.rawContent ?? JSON.stringify(step.body ?? {}),
          },
          finish_reason: step.finishReason ?? "stop",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50, cost: step.cost ?? 0.001 },
    };
    return {
      ok: (step.status ?? 200) < 400,
      status: step.status ?? 200,
      text: async () => JSON.stringify(payload),
    };
  };
  return { fetchImpl, requests };
}

const answer = (probabilities: number[], confidence = 0.8) => ({
  probabilities,
  confidence,
  reasoning: "because",
  contradictions: "maybe not",
  uncertainty: "more data",
});

async function marketWithPrices(): Promise<Market> {
  const port = new FakeDelphi([
    {
      id: "0x00000000000000000000000000000000000000a1",
      question: "Will BTC close above $150,000 before September?",
      outcomes: ["Yes", "No"],
      supplies: [200, 800],
      judgeModel: "judge/model-x",
      promptContext: "Resolve YES only if a major exchange prints above 150000.",
    },
  ]);
  return port.getMarket("0x00000000000000000000000000000000000000a1", true);
}

const opinion = (
  over: Partial<ModelOpinion> & { probabilities: number[] },
): ModelOpinion => ({
  model: "m",
  role: "analyst",
  selfConfidence: 0.8,
  reasoning: "r",
  costUsd: 0,
  latencyMs: 1,
  ...over,
});

// ------------------------------------------------------------------ tests

describe("parseJsonLoose", () => {
  it("parses clean JSON", () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });
  it("strips code fences", () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it("extracts an object buried in prose", () => {
    expect(parseJsonLoose('Sure!\n{"a":1}\nHope that helps')).toEqual({ a: 1 });
  });
  it("handles braces inside strings", () => {
    expect(parseJsonLoose('x {"a":"}{"} y')).toEqual({ a: "}{" });
  });
  it("throws on genuinely unparseable output", () => {
    expect(() => parseJsonLoose("no json here")).toThrow();
  });
});

describe("OpenRouterClient", () => {
  it("returns parsed content and records cost", async () => {
    const { fetchImpl } = transport([{ body: answer([0.6, 0.4]), cost: 0.004 }]);
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl });

    const result = await client.complete({ model: "m", system: "s", user: "u" });
    expect(JSON.parse(result.text).probabilities).toEqual([0.6, 0.4]);
    expect(client.spent).toBeCloseTo(0.004, 6);
    expect(client.calls).toBe(1);
  });

  it("retries a 429 and then succeeds", async () => {
    const { fetchImpl } = transport([
      { status: 429 },
      { body: answer([0.6, 0.4]) },
    ]);
    const client = new OpenRouterClient({
      apiKey: "k",
      fetchImpl,
      sleep: async () => {},
    });
    const result = await client.complete({ model: "m", system: "s", user: "u" });
    expect(result.text).toContain("probabilities");
  });

  it("does not retry a 400 — it will never succeed", async () => {
    const sleep = vi.fn(async () => {});
    const { fetchImpl } = transport([{ status: 400 }]);
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl, sleep });

    await expect(
      client.complete({ model: "m", system: "s", user: "u" }),
    ).rejects.toThrow(/400/);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after maxRetries", async () => {
    const { fetchImpl } = transport([{ status: 500 }]);
    const client = new OpenRouterClient({
      apiKey: "k",
      fetchImpl,
      maxRetries: 2,
      sleep: async () => {},
    });
    await expect(
      client.complete({ model: "m", system: "s", user: "u" }),
    ).rejects.toThrow(/after 3 attempts/);
  });

  it("refuses to spend past the budget ceiling", async () => {
    const { fetchImpl } = transport([{ body: answer([0.5, 0.5]), cost: 0.2 }]);
    const client = new OpenRouterClient({
      apiKey: "k",
      fetchImpl,
      maxCostUsd: 0.15,
    });

    await client.complete({ model: "m", system: "s", user: "u" });
    expect(client.exhausted).toBe(true);
    await expect(
      client.complete({ model: "m", system: "s", user: "u" }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  // Regression: a live run had gpt-5 return empty content four times and
  // gemini truncate mid-JSON. Both were the token ceiling, not a parse bug, and
  // both were retried pointlessly at ~10s a go.
  it("reports a truncated response as a token-ceiling problem, without retrying", async () => {
    const sleep = vi.fn(async () => {});
    const { fetchImpl, requests } = transport([
      {
        rawContent: '{"probabilities": [0.15, 0.85], "confidence": 0.4, "',
        finishReason: "length",
      },
    ]);
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl, sleep });

    await expect(
      client.complete({ model: "m", system: "s", user: "u" }),
    ).rejects.toThrow(/token ceiling.*truncated/s);
    expect(requests).toHaveLength(1); // no wasted retries
    expect(sleep).not.toHaveBeenCalled();
  });

  it("explains an empty response when reasoning consumed the whole budget", async () => {
    const { fetchImpl, requests } = transport([
      { rawContent: "", finishReason: "length" },
    ]);
    const client = new OpenRouterClient({
      apiKey: "k",
      fetchImpl,
      sleep: async () => {},
    });

    await expect(
      client.complete({ model: "m", system: "s", user: "u" }),
    ).rejects.toThrow(/reasoning consumed the budget/);
    expect(requests).toHaveLength(1);
  });

  it("forwards a reasoning-effort cap when asked", async () => {
    const captured: unknown[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      captured.push(JSON.parse(String(init.body)));
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
            usage: { cost: 0 },
          }),
      };
    };
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl });
    await client.complete({
      model: "m",
      system: "s",
      user: "u",
      reasoningEffort: "low",
    });
    expect(captured[0]).toMatchObject({ reasoning: { effort: "low" } });
  });

  // Regression: the timeout used to cover only the connection, so a response
  // whose body trickled in could hang forever. A live run recorded a 72s call
  // completing under a 60s timeout.
  it("times out a response whose body stalls after the headers arrive", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      // Headers arrived; the body never does.
      text: () => new Promise<string>(() => {}),
    });
    const client = new OpenRouterClient({
      apiKey: "k",
      fetchImpl,
      timeoutMs: 40,
      maxRetries: 0,
      sleep: async () => {},
    });

    await expect(
      client.complete({ model: "m", system: "s", user: "u" }),
    ).rejects.toThrow(/40ms timeout/);
  });

  it("times out a transport that ignores the abort signal entirely", async () => {
    const fetchImpl: FetchLike = () => new Promise(() => {});
    const client = new OpenRouterClient({
      apiKey: "k",
      fetchImpl,
      timeoutMs: 40,
      maxRetries: 0,
      sleep: async () => {},
    });

    await expect(
      client.complete({ model: "m", system: "s", user: "u" }),
    ).rejects.toThrow(/40ms timeout/);
  });

  it("treats a 200 carrying an error body as a failure", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ error: { message: "no credits" } }),
    });
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl });
    await expect(
      client.complete({ model: "m", system: "s", user: "u" }),
    ).rejects.toThrow(/no credits/);
  });
});

describe("aggregation", () => {
  it("averages agreeing models and reports high confidence", () => {
    const out = aggregate([
      opinion({ probabilities: [0.7, 0.3] }),
      opinion({ probabilities: [0.72, 0.28] }),
      opinion({ probabilities: [0.68, 0.32] }),
    ]);
    expect(out.probabilities[0]).toBeCloseTo(0.7, 2);
    expect(out.confidence).toBeGreaterThan(0.8);
  });

  it("collapses confidence when models disagree", () => {
    const out = aggregate([
      opinion({ probabilities: [0.9, 0.1] }),
      opinion({ probabilities: [0.1, 0.9] }),
    ]);
    expect(out.probabilities[0]).toBeCloseTo(0.5, 2);
    expect(out.confidence).toBeLessThan(0.2);
  });

  it("weights the settlement judge above an analyst", () => {
    const withJudge = aggregate(
      [
        opinion({ probabilities: [0.2, 0.8], model: "a" }),
        opinion({ probabilities: [0.8, 0.2], model: "j", role: "judge" }),
      ],
      3,
    );
    // Judge at weight 3 vs analyst at 1 => (0.2 + 2.4)/4 = 0.65
    expect(withJudge.probabilities[0]!).toBeGreaterThan(0.6);
  });

  it("caps confidence for a lone model — nothing cross-checks it", () => {
    const solo = aggregate([opinion({ probabilities: [0.9, 0.1], selfConfidence: 1 })]);
    expect(solo.confidence).toBeLessThanOrEqual(0.6);
  });

  it("does not let a confident self-report manufacture confidence", () => {
    const disagreeing = aggregate([
      opinion({ probabilities: [0.95, 0.05], selfConfidence: 1 }),
      opinion({ probabilities: [0.05, 0.95], selfConfidence: 1 }),
    ]);
    expect(disagreeing.confidence).toBeLessThan(0.2);
  });
});

describe("agreementScore", () => {
  it("is 1 for identical distributions", () => {
    expect(agreementScore([[0.6, 0.4], [0.6, 0.4]])).toBeCloseTo(1, 6);
  });
  it("is 0 for opposite distributions", () => {
    expect(agreementScore([[1, 0], [0, 1]])).toBeCloseTo(0, 6);
  });
});

describe("maxGap", () => {
  it("finds the largest per-outcome disagreement", () => {
    expect(maxGap([0.6, 0.4], [0.5, 0.5])).toBeCloseTo(0.1, 6);
  });
  it("treats a market with no prices as always worth examining", () => {
    expect(maxGap([0.6, 0.4], [])).toBe(1);
  });
});

describe("normalizeProbabilities", () => {
  it("rescales to sum 1", () => {
    const p = normalizeProbabilities([2, 2]);
    expect(p[0]! + p[1]!).toBeCloseTo(1, 9);
  });
  it("falls back to uniform rather than inventing a signal", () => {
    expect(normalizeProbabilities([0, 0])).toEqual([0.5, 0.5]);
  });
  it("clamps out-of-range and non-finite values", () => {
    const p = normalizeProbabilities([1.5, NaN]);
    expect(p[0]).toBeCloseTo(1, 6);
    expect(p[1]).toBeCloseTo(0, 6);
  });
});

describe("cache freshness", () => {
  const base: CachedEstimate = {
    estimate: { probabilities: [0.6, 0.4], confidence: 0.8, reasoning: "" },
    cachedAt: new Date("2026-08-01T00:00:00Z").getTime(),
    marketProbabilities: [0.5, 0.5],
    metadataFingerprint: "abc",
  };
  const policy = { ttlMinutes: 60, invalidateOnMove: 0.05 };

  it("reuses a fresh, unmoved entry", () => {
    expect(
      stalenessReason(base, [0.5, 0.5], "abc", policy, new Date("2026-08-01T00:30:00Z")),
    ).toBeNull();
  });

  it("expires after the TTL", () => {
    expect(
      stalenessReason(base, [0.5, 0.5], "abc", policy, new Date("2026-08-01T02:00:00Z")),
    ).toBe("expired");
  });

  it("invalidates when the market repriced", () => {
    expect(
      stalenessReason(base, [0.62, 0.38], "abc", policy, new Date("2026-08-01T00:10:00Z")),
    ).toBe("market-moved");
  });

  it("invalidates when the question text changed", () => {
    expect(
      stalenessReason(base, [0.5, 0.5], "zzz", policy, new Date("2026-08-01T00:10:00Z")),
    ).toBe("metadata-changed");
  });

  it("fingerprints question and outcomes together", () => {
    expect(fingerprintMetadata("q", ["a", "b"])).toBe(fingerprintMetadata("q", ["a", "b"]));
    expect(fingerprintMetadata("q", ["a", "b"])).not.toBe(
      fingerprintMetadata("q", ["a", "c"]),
    );
  });
});

describe("free-model handling", () => {
  it("recognises OpenRouter's zero-cost ids", () => {
    expect(isFreeModel("openai/gpt-oss-20b:free")).toBe(true);
    expect(isFreeModel("openrouter/free")).toBe(true);
    expect(isFreeModel("anthropic/claude-opus-5")).toBe(false);
  });

  it("parses fallback chains", () => {
    expect(parseModelChain("a:free|b:free")).toEqual(["a:free", "b:free"]);
    expect(parseModelChain(" a:free | b:free ")).toEqual(["a:free", "b:free"]);
    expect(parseModelChain("solo")).toEqual(["solo"]);
  });
});

describe("EnsembleEstimator cost controls", () => {
  it("falls back to the next model when the first is rate-limited", async () => {
    const market = await marketWithPrices();
    const { fetchImpl, requests } = transport([
      { body: answer([0.45, 0.55]) }, // triage OK
      { status: 429 }, // primary analyst rate-limited
      { body: answer([0.4, 0.6]) }, // fallback answers
    ]);
    const client = new OpenRouterClient({
      apiKey: "k",
      fetchImpl,
      maxRetries: 0,
      sleep: async () => {},
    });

    const out = await new EnsembleEstimator({
      client,
      models: ["primary/one:free|backup/two:free"],
      triageModel: "cheap/one:free",
      triageGapThreshold: 0.1,
      replicateJudge: false,
    }).estimate(market, { summary: "", sources: [] });

    expect(requests.map((r) => r.model)).toContain("backup/two:free");
    expect(out.confidence).toBeGreaterThan(0);
  });

  it("substitutes a free model for a paid settlement judge by default", async () => {
    const market = await marketWithPrices(); // judge is "judge/model-x" (paid)
    const { fetchImpl, requests } = transport([{ body: answer([0.45, 0.55]) }]);
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl });

    await new EnsembleEstimator({
      client,
      models: ["free/one:free"],
      triageModel: "cheap/one:free",
      triageGapThreshold: 0.1,
    }).estimate(market, { summary: "", sources: [] });

    const models = requests.map((r) => r.model);
    expect(models).not.toContain("judge/model-x"); // paid judge not called
    // The judge *prompt* still runs, which is where the edge comes from.
    expect(requests.some((r) => r.system.includes("what the judge will rule"))).toBe(
      true,
    );
  });

  it("calls the real settlement judge once paid models are allowed", async () => {
    const market = await marketWithPrices();
    const { fetchImpl, requests } = transport([{ body: answer([0.45, 0.55]) }]);
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl });

    await new EnsembleEstimator({
      client,
      models: ["free/one:free"],
      triageModel: "cheap/one:free",
      triageGapThreshold: 0.1,
      allowPaidFallback: true,
    }).estimate(market, { summary: "", sources: [] });

    expect(requests.map((r) => r.model)).toContain("judge/model-x");
  });

  it("skips paid entries inside a mixed chain unless allowed", async () => {
    const market = await marketWithPrices();
    const { fetchImpl, requests } = transport([{ body: answer([0.45, 0.55]) }]);
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl });

    await new EnsembleEstimator({
      client,
      models: ["free/one:free|expensive/two"],
      triageModel: "cheap/one:free",
      triageGapThreshold: 0.1,
      replicateJudge: false,
    }).estimate(market, { summary: "", sources: [] });

    expect(requests.map((r) => r.model)).not.toContain("expensive/two");
  });

  it("honours an all-paid chain, since that is clearly deliberate", async () => {
    const market = await marketWithPrices();
    const { fetchImpl, requests } = transport([{ body: answer([0.45, 0.55]) }]);
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl });

    await new EnsembleEstimator({
      client,
      models: ["expensive/one"],
      triageModel: "cheap/one:free",
      triageGapThreshold: 0.1,
      replicateJudge: false,
    }).estimate(market, { summary: "", sources: [] });

    expect(requests.map((r) => r.model)).toContain("expensive/one");
  });

  it("lets an explicit judge override win", async () => {
    const market = await marketWithPrices();
    const { fetchImpl, requests } = transport([{ body: answer([0.45, 0.55]) }]);
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl });

    await new EnsembleEstimator({
      client,
      models: ["free/one:free"],
      triageModel: "cheap/one:free",
      triageGapThreshold: 0.1,
      judgeModelOverride: "chosen/judge:free",
    }).estimate(market, { summary: "", sources: [] });

    expect(requests.map((r) => r.model)).toContain("chosen/judge:free");
  });
});

describe("EnsembleEstimator", () => {
  const freshness = { ttlMinutes: 60, invalidateOnMove: 0.05 };

  it("stops at triage when the market is priced about right", async () => {
    const market = await marketWithPrices(); // implied [5.88%, 94.12%]
    const { fetchImpl, requests } = transport([{ body: answer([0.07, 0.93]) }]);
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl });

    const estimator = new EnsembleEstimator({
      client,
      models: ["big/one", "big/two"],
      triageModel: "cheap/one",
      triageGapThreshold: 0.1,
    });

    const out = await estimator.estimate(market, { summary: "", sources: [] });

    expect(requests).toHaveLength(1); // only the cheap model ran
    expect(requests[0]!.model).toBe("cheap/one");
    expect(out.confidence).toBe(0); // cannot trade on a triage-only view
  });

  it("escalates to the ensemble when triage sees a real gap", async () => {
    const market = await marketWithPrices();
    const { fetchImpl, requests } = transport([{ body: answer([0.45, 0.55]) }]);
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl });

    const estimator = new EnsembleEstimator({
      client,
      models: ["big/one", "big/two"],
      triageModel: "cheap/one",
      triageGapThreshold: 0.1,
      allowPaidFallback: true, // assert against the real settlement judge
    });

    const out = await estimator.estimate(market, { summary: "", sources: [] });

    // triage + 2 analysts + 1 judge
    expect(requests).toHaveLength(4);
    expect(requests.map((r) => r.model)).toContain("judge/model-x");
    expect(out.confidence).toBeGreaterThan(0);
  });

  it("sends the market's own prompt_context to the judge replica", async () => {
    const market = await marketWithPrices();
    const { fetchImpl, requests } = transport([{ body: answer([0.45, 0.55]) }]);
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl });

    await new EnsembleEstimator({
      client,
      models: ["big/one"],
      triageModel: "cheap/one",
      triageGapThreshold: 0.1,
      allowPaidFallback: true, // assert against the real settlement judge
    }).estimate(market, { summary: "", sources: [] });

    const judgeCall = requests.find((r) => r.model === "judge/model-x");
    expect(judgeCall).toBeDefined();
    expect(judgeCall!.user).toContain("major exchange prints above 150000");
    expect(judgeCall!.system).toContain("what the judge will rule");
  });

  it("can be told not to replicate the judge", async () => {
    const market = await marketWithPrices();
    const { fetchImpl, requests } = transport([{ body: answer([0.45, 0.55]) }]);
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl });

    await new EnsembleEstimator({
      client,
      models: ["big/one"],
      triageModel: "cheap/one",
      triageGapThreshold: 0.1,
      replicateJudge: false,
    }).estimate(market, { summary: "", sources: [] });

    expect(requests.map((r) => r.model)).not.toContain("judge/model-x");
  });

  it("serves a second identical run from cache", async () => {
    const market = await marketWithPrices();
    const { fetchImpl, requests } = transport([{ body: answer([0.45, 0.55]) }]);
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl });
    const cache = new MemoryEstimateCache();

    const estimator = new EnsembleEstimator({
      client,
      models: ["big/one"],
      triageModel: "cheap/one",
      triageGapThreshold: 0.1,
      cache,
      freshness,
    });

    await estimator.estimate(market, { summary: "", sources: [] });
    const afterFirst = requests.length;
    await estimator.estimate(market, { summary: "", sources: [] });

    expect(requests.length).toBe(afterFirst); // no new calls
    expect(cache.size).toBe(1);
  });

  it("discards a model that returns the wrong number of outcomes", async () => {
    const market = await marketWithPrices();
    const { fetchImpl } = transport([
      { body: answer([0.45, 0.55]) }, // triage OK
      { body: answer([0.3, 0.3, 0.4]) }, // analyst: 3 outcomes for a binary market
      { body: answer([0.45, 0.55]) }, // judge OK
    ]);
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl });

    const out = await new EnsembleEstimator({
      client,
      models: ["big/one"],
      triageModel: "cheap/one",
      triageGapThreshold: 0.1,
    }).estimate(market, { summary: "", sources: [] });

    expect(out.probabilities).toHaveLength(2);
  });

  it("returns an untradeable estimate when every model fails", async () => {
    const market = await marketWithPrices();
    const { fetchImpl } = transport([
      { body: answer([0.45, 0.55]) }, // triage OK
      { status: 400 }, // everything after fails
    ]);
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl, sleep: async () => {} });

    const out = await new EnsembleEstimator({
      client,
      models: ["big/one"],
      triageModel: "cheap/one",
      triageGapThreshold: 0.1,
    }).estimate(market, { summary: "", sources: [] });

    expect(out.confidence).toBe(0);
  });

  it("does not call any model once the budget is gone", async () => {
    const market = await marketWithPrices();
    const { fetchImpl, requests } = transport([{ body: answer([0.5, 0.5]), cost: 1 }]);
    const client = new OpenRouterClient({ apiKey: "k", fetchImpl, maxCostUsd: 0.5 });

    await client.complete({ model: "warmup", system: "s", user: "u" });
    const before = requests.length;

    const out = await new EnsembleEstimator({
      client,
      models: ["big/one"],
      triageModel: "cheap/one",
      triageGapThreshold: 0.1,
    }).estimate(market, { summary: "", sources: [] });

    expect(requests.length).toBe(before);
    expect(out.confidence).toBe(0);
  });
});
