import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
export function detectSandboxAvailability() {
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
    const errors = [...dependencies.errors];
    // The pinned runtime reports its missing Linux Unix-socket filter as a warning.
    if (backend === "linux-bubblewrap" &&
        dependencies.warnings.includes("seccomp not available - unix socket access not restricted")) {
        errors.push("Unix-socket filter helper is unavailable. Restore a supported sandbox runtime installation.");
    }
    return {
        available: errors.length === 0,
        backend,
        label,
        reason: errors.length > 0 ? `Sandbox dependencies are unavailable: ${errors.join(", ")}` : null,
        warnings: dependencies.warnings,
    };
}
