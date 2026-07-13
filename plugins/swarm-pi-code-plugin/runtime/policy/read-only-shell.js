const MAX_READ_ONLY_COMMAND_LENGTH = 1_500;
const SAFE_SEGMENT_PATTERNS = [
    /^(?:\/usr\/bin\/|\/bin\/)?pwd(?:\s+--)?$/,
    /^(?:\/usr\/bin\/|\/bin\/)?git\s+status(?:\s+[^\s]+)*$/,
    /^(?:\/usr\/bin\/|\/bin\/)?git\s+ls-files(?:\s+[^\s]+)*$/,
    /^(?:\/usr\/bin\/|\/bin\/)?git\s+rev-parse(?:\s+[^\s]+)*$/,
    /^(?:\/usr\/bin\/|\/bin\/)?(?:rustc|cargo)\s+(?:--version|-V|-Vv)(?:\s+--verbose)?$/,
    /^(?:\/usr\/bin\/|\/bin\/)?cmp(?:\s+(?:-s|--silent|--quiet))*\s+(?!-)[^\s]+\s+(?!-)[^\s]+$/,
    /^(?:\/usr\/bin\/|\/bin\/)?diff(?:\s+(?:-q|--brief|-u|--unified(?:=\d+)?|-s|--report-identical-files))*\s+(?!-)[^\s]+\s+(?!-)[^\s]+$/,
    /^(?:\/usr\/bin\/|\/bin\/)?(?:ls|cat|head|tail|wc|stat|file|du|tree|sort|uniq|cut|tr|jq|grep|sha256sum|shasum)(?:\s+.*)?$/,
    /^(?:\/usr\/bin\/|\/bin\/)?(?:rg|fd)(?:\s+.*)?$/,
    /^(?:\/usr\/bin\/|\/bin\/)?find(?:\s+.*)?$/,
    /^(?:\/usr\/bin\/|\/bin\/)?sed\s+-n\s+['"]?\d+(?:,\d+)?p['"]?(?:\s+[^\s]+)+$/,
    /^(?:\/usr\/bin\/|\/bin\/)?(?:realpath|readlink|which)(?:\s+.*)?$/,
    /^(?:type|command\s+-v|echo|printf|test|\[)(?:\s+.*)?$/,
];
/**
 * Recognize a deliberately small subset of shell commands whose observable
 * effect is confined to stdout/stderr and process exit status. False negatives
 * are expected: anything outside this grammar must fall back to Host/user
 * review instead of being treated as read-only.
 */
export function isReadOnlyShellCommand(command) {
    const value = command.trim();
    if (!value || value.length > MAX_READ_ONLY_COMMAND_LENGTH)
        return false;
    // Reject shell expansion, redirection, backgrounding, alternate branches,
    // statement separators, multiline programs, and traversal before splitting
    // the two supported composition operators (`&&` and a simple pipeline).
    if (/[\r\n;<>`$]/.test(value) ||
        /\|\|/.test(value) ||
        /(^|[^&])&([^&]|$)/.test(value) ||
        /(?:^|[\s'"/])\.\.(?:[/\s'"]|$)/.test(value) ||
        /(?:^|[\s'"=])(\/(?!usr\/bin\/|bin\/))/.test(value)) {
        return false;
    }
    const segments = value.split(/\s*(?:&&|\|)\s*/);
    if (segments.length === 0 || segments.some((segment) => !segment.trim()))
        return false;
    return segments.every(isReadOnlySegment);
}
function isReadOnlySegment(segment) {
    const value = segment.trim();
    if (!SAFE_SEGMENT_PATTERNS.some((pattern) => pattern.test(value)))
        return false;
    if (/^(?:\/usr\/bin\/|\/bin\/)?find\b/.test(value)) {
        return !/\s-(?:delete|exec|execdir|ok|okdir|fls|fprint|fprintf)(?:\s|$)/.test(value);
    }
    if (/^(?:\/usr\/bin\/|\/bin\/)?(?:rg|fd)\b/.test(value)) {
        return !/(?:^|\s)(?:--(?:pre|pre-glob|exec-batch|exec)(?:[=\s]|$)|-[xX](?:\s|$))/.test(value);
    }
    if (/^(?:\/usr\/bin\/|\/bin\/)?(?:sort|tree)\b/.test(value)) {
        return !/(?:^|\s)(?:-o|--output)(?:[=\s]|$)/.test(value);
    }
    if (/^(?:\/usr\/bin\/|\/bin\/)?file\b/.test(value)) {
        return !/(?:^|\s)(?:-C|--compile)(?:\s|$)/.test(value);
    }
    return true;
}
