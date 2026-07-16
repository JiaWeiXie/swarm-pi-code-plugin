import {
  parsePricingSnapshot,
  parseUsageSnapshot,
  type CostStatusSnapshot,
  type IsoDate,
  type PricingEntry,
  type PricingSnapshot,
  type UsageDimension,
  type UsageSnapshot,
} from "./contracts.js";

export interface CostCalculationOptions {
  at: IsoDate;
  /** Price data older than this threshold is visible as `stale`, never used silently. */
  maxPricingAgeMs?: number;
  /** Local models are usage-only and never receive an invented currency amount. */
  localModel?: boolean;
}

const DEFAULT_MAX_PRICING_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DIMENSIONS: readonly UsageDimension[] = ["inputTokens", "outputTokens", "cachedInputTokens"];

function invalidInput(): CostStatusSnapshot {
  return {
    schemaVersion: 1,
    status: "unknown",
    attribution: "unattributed",
    reason: "invalid-input",
  };
}

function roundedMinorUnits(count: number, pricing: PricingEntry): string {
  const numerator = BigInt(count) * BigInt(pricing.rateMinorUnits);
  const denominator = BigInt(pricing.unitTokens);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return (remainder * 2n >= denominator ? quotient + 1n : quotient).toString();
}

function parseAt(at: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(at))
    throw new TypeError("invalid calculation timestamp");
  const timestamp = Date.parse(at);
  if (Number.isNaN(timestamp)) throw new TypeError("invalid calculation timestamp");
  return timestamp;
}

export function selectPricing(
  snapshotInput: PricingSnapshot | unknown,
  provider: string,
  model: string,
  dimension: UsageDimension,
  at: IsoDate,
): PricingEntry | undefined {
  const snapshot = parsePricingSnapshot(snapshotInput);
  const timestamp = parseAt(at);
  return snapshot.entries.find(
    (entry) =>
      entry.provider === provider &&
      entry.model === model &&
      entry.dimension === dimension &&
      Date.parse(entry.effectiveFrom) <= timestamp &&
      (entry.effectiveTo === undefined || timestamp < Date.parse(entry.effectiveTo)),
  );
}

/** Calculate one pricing dimension with integer minor-unit arithmetic and half-up rounding. */
export function calculateDimensionCost(usageCount: number, pricing: PricingEntry): string {
  if (!Number.isSafeInteger(usageCount) || usageCount < 0)
    throw new TypeError("usage count must be a non-negative integer");
  return roundedMinorUnits(usageCount, pricing);
}

export function costForUsage(
  usageInput: UsageSnapshot | unknown,
  pricingInput: PricingSnapshot | unknown,
  options: CostCalculationOptions,
): CostStatusSnapshot {
  try {
    const usage = parseUsageSnapshot(usageInput);
    const pricing = parsePricingSnapshot(pricingInput);
    const at = parseAt(options.at);
    const maxAge = options.maxPricingAgeMs ?? DEFAULT_MAX_PRICING_AGE_MS;
    if (!Number.isSafeInteger(maxAge) || maxAge < 0) return invalidInput();
    const present = DIMENSIONS.filter((dimension) => usage[dimension] !== undefined);
    if (present.length === 0) {
      return {
        schemaVersion: 1,
        status: "unknown",
        attribution: "unattributed",
        reason: "missing-usage",
      };
    }
    if (options.localModel) {
      return {
        schemaVersion: 1,
        status: "local-usage-only",
        attribution: "local",
        reason: "local-model",
      };
    }
    const age = at - Date.parse(pricing.asOf);
    if (age > maxAge) {
      return {
        schemaVersion: 1,
        status: "stale",
        attribution: "provider",
        reason: "stale-pricing",
        pricingAsOf: pricing.asOf,
      };
    }
    const matches = present.map((dimension) => ({
      dimension,
      entry: selectPricing(pricing, usage.provider, usage.model, dimension, options.at),
    }));
    const priced = matches.filter(
      (match): match is { dimension: UsageDimension; entry: PricingEntry } =>
        match.entry !== undefined,
    );
    if (priced.length === 0) {
      return {
        schemaVersion: 1,
        status: "unknown",
        attribution: "provider",
        reason: "missing-pricing",
        pricingAsOf: pricing.asOf,
      };
    }
    const amounts: Partial<Record<PricingEntry["currency"], bigint>> = {};
    for (const match of priced) {
      const amount = BigInt(calculateDimensionCost(usage[match.dimension]!, match.entry));
      amounts[match.entry.currency] = (amounts[match.entry.currency] ?? 0n) + amount;
    }
    const currencies = Object.keys(amounts);
    if (priced.length !== present.length) {
      return {
        schemaVersion: 1,
        status: "unsupported-dimension",
        attribution: "provider",
        reason: "partial-pricing",
        pricingAsOf: pricing.asOf,
        ...(currencies.length === 0
          ? {}
          : { amountsMinorUnitsByCurrency: toDecimalAmounts(amounts) }),
      };
    }
    if (currencies.length !== 1) {
      return {
        schemaVersion: 1,
        status: "unsupported-dimension",
        attribution: "provider",
        reason: "mixed-currency",
        pricingAsOf: pricing.asOf,
        amountsMinorUnitsByCurrency: toDecimalAmounts(amounts),
      };
    }
    const currency = currencies[0] as PricingEntry["currency"];
    return {
      schemaVersion: 1,
      status: "priced",
      attribution: "provider",
      reason: "complete",
      currency,
      amountMinorUnits: amounts[currency]!.toString(),
      pricingAsOf: pricing.asOf,
    };
  } catch {
    return invalidInput();
  }
}

export const calculateCost = costForUsage;

function toDecimalAmounts(
  amounts: Partial<Record<PricingEntry["currency"], bigint>>,
): Partial<Record<PricingEntry["currency"], string>> {
  const result: Partial<Record<PricingEntry["currency"], string>> = {};
  for (const [currency, amount] of Object.entries(amounts)) {
    if (amount !== undefined) result[currency as PricingEntry["currency"]] = amount.toString();
  }
  return result;
}
