import { SandboxManager } from "@carderne/sandbox-runtime";

export interface SandboxAvailability {
  available: boolean;
  backend: "macos-seatbelt" | "linux-bubblewrap" | "unsupported";
  label: string;
  reason: string | null;
  warnings: string[];
}

export function detectSandboxAvailability(): SandboxAvailability {
  const backend = process.platform === "darwin"
    ? "macos-seatbelt"
    : process.platform === "linux"
      ? "linux-bubblewrap"
      : "unsupported";
  const label = backend === "macos-seatbelt"
    ? "macOS Seatbelt"
    : backend === "linux-bubblewrap"
      ? "Linux Bubblewrap"
      : `Unsupported (${process.platform})`;

  if (!SandboxManager.isSupportedPlatform()) {
    return {
      available: false,
      backend,
      label,
      reason: `Lenient sandboxing is not supported on ${process.platform}.`,
      warnings: [],
    };
  }

  const dependencies = SandboxManager.checkDependencies();
  return {
    available: dependencies.errors.length === 0,
    backend,
    label,
    reason: dependencies.errors.length > 0
      ? `Sandbox dependencies are unavailable: ${dependencies.errors.join(", ")}`
      : null,
    warnings: dependencies.warnings,
  };
}
