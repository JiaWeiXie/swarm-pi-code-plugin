export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
export const IMPLEMENT_TOOLS = [...READ_ONLY_TOOLS, "write", "edit"];
export function toolsForMode(mode) {
    return [...(mode === "implement" ? IMPLEMENT_TOOLS : READ_ONLY_TOOLS)];
}
