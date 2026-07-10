export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

export const IMPLEMENT_TOOLS = [
  ...READ_ONLY_TOOLS,
  "write",
  "edit",
] as const;

export function toolsForMode(mode: "readonly" | "implement"): string[] {
  return [...(mode === "implement" ? IMPLEMENT_TOOLS : READ_ONLY_TOOLS)];
}
