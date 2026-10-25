/**
 * What each model call costs, from Google's Agent Platform (Vertex AI) price list, global region,
 * checked 25 October 2026 (backend/README.md). Prices are USD per 1M tokens, so the cost in
 * micro-dollars is simply tokens × price. Thinking tokens are billed as output.
 *
 * Pure: no I/O, unit-tested in tests/usage.test.ts. When Google changes a price, add a new dated row;
 * old calls keep the price they were made at.
 */

type Rate = { from: string; input: number; cachedInput: number; output: number };

const RATES: Record<string, Rate[]> = {
  "gemini-3.8-flash": [
    { from: "2000-01-01", input: 0.75, cachedInput: 0.075, output: 3.75 },
    { from: "2027-01-01", input: 1.5, cachedInput: 0.15, output: 7.5 },
  ],
  "gemini-3.7-flash": [
    { from: "2000-01-01", input: 0.75, cachedInput: 0.075, output: 3.75 },
    { from: "2027-01-01", input: 1.5, cachedInput: 0.15, output: 7.5 },
  ],
  "gemini-3.6-flash": [
    { from: "2000-01-01", input: 0.75, cachedInput: 0.075, output: 3.75 },
    { from: "2027-01-01", input: 1.5, cachedInput: 0.15, output: 7.5 },
  ],
  "gemini-3.5-flash-lite": [{ from: "2000-01-01", input: 0.3, cachedInput: 0.03, output: 2.5 }],
  "gemini-3.1-flash-lite": [{ from: "2000-01-01", input: 0.25, cachedInput: 0.025, output: 1.5 }],
  "gemini-4-argon": [
    { from: "2000-01-01", input: 2, cachedInput: 0.1, output: 10 },
    { from: "2026-12-01", input: 4, cachedInput: 0.2, output: 20 },
  ],
};

/** A named region costs 10% more than the global endpoint. */
const REGION_UPLIFT = 1.1;

export type TokenUsage = { inputTokens: number; outputTokens: number; thoughtTokens?: number; cachedTokens?: number };

export function rateFor(model: string, at: Date = new Date()): Rate | null {
  const rows = RATES[model];
  if (!rows) return null;
  const day = at.toISOString().slice(0, 10);
  return rows.filter((r) => r.from <= day).at(-1) ?? null;
}

/** Cost of one call in micro-dollars (1,000,000 = $1), or null for a model we have no price for. */
export function costMicros(model: string, usage: TokenUsage, { at = new Date(), location = "global" } = {}): number | null {
  const rate = rateFor(model, at);
  if (!rate) return null;
  const cached = Math.min(usage.cachedTokens ?? 0, usage.inputTokens);
  const raw = (usage.inputTokens - cached) * rate.input + cached * rate.cachedInput + (usage.outputTokens + (usage.thoughtTokens ?? 0)) * rate.output;
  return Math.round(raw * (location === "global" ? 1 : REGION_UPLIFT));
}

/** "$0.042" for people reading reports; costs under a cent keep three decimals. */
export function dollars(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(micros < 10_000 ? 4 : 3)}`;
}
