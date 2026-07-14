export const HOST_CONTEXT_CHARACTERS_PER_UNIT = 8_192;
export const HOST_CONTEXT_MAX_CHARACTERS = 64_000;

export const HOST_CONTEXT_ALLOWANCE_PRESETS = Object.freeze([
  Object.freeze({
    value: 0,
    label: "Off — no Host context",
    description: "Workers cannot request Host-provided context.",
  }),
  Object.freeze({
    value: 1,
    label: "Compact — up to 8,192 characters",
    description: "Short facts, citations, or one focused documentation answer.",
  }),
  Object.freeze({
    value: 4,
    label: "Standard — up to 32,768 characters (recommended)",
    description: "Ordinary repository and documentation assistance.",
  }),
  Object.freeze({
    value: 8,
    label: "Extended — up to 64,000 characters",
    description: "Large evidence bundles when Standard is insufficient.",
  }),
] as const);

export function hostContextCharacterLimit(budget: number): number {
  if (!Number.isFinite(budget) || budget <= 0) return 0;
  return Math.min(
    HOST_CONTEXT_MAX_CHARACTERS,
    Math.trunc(budget) * HOST_CONTEXT_CHARACTERS_PER_UNIT,
  );
}
