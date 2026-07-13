/** Stable public discriminator for the Job event stream. */
export const JOB_EVENT_SCHEMA = "swarm-pi-code-plugin/job-event";
export const JOB_EVENT_VERSION = 1;
/**
 * Project canonical state into the intentionally small public Job event shape.
 *
 * This function never spreads a JobRecord, ApprovalRequest, or PolicyDecision
 * into an event. That is deliberate: state contains worker tokens, request
 * metadata, leases, and other values that must not cross the Host boundary.
 * A caller can invoke this on every polling pass and use `dedupeJobEvents` to
 * retain only newly observed event IDs.
 */
export function projectJobEvents(state, options = {}) {
    const emittedAt = iso(options.now ?? new Date());
    const since = options.since === undefined ? undefined : time(options.since);
    const includeProgress = options.includeProgress ?? true;
    const includeResolved = options.includeResolved ?? false;
    const projected = [];
    let ordinal = 0;
    for (const job of state.jobs) {
        if (options.jobId !== undefined && job.id !== options.jobId)
            continue;
        const notifications = job.notifications ?? [];
        const approvals = job.approvals ?? [];
        const terminalNotification = notifications.find((notification) => notification.kind === "terminal");
        const terminalPending = terminalNotification?.status === "pending" ||
            (terminalNotification === undefined &&
                job.notification === "pending" &&
                isTerminalStatus(job.status));
        if (terminalPending && isTerminalStatus(job.status)) {
            const notificationId = terminalNotification?.id ?? `terminal:${job.id}`;
            const finishedAt = job.finishedAt ?? job.updatedAt ?? job.createdAt ?? emittedAt;
            push({
                schema: JOB_EVENT_SCHEMA,
                version: JOB_EVENT_VERSION,
                eventId: notificationId,
                event: "job-terminal",
                emittedAt,
                jobId: job.id,
                notificationId,
                status: job.status,
                finishedAt,
            }, time(finishedAt));
        }
        for (const approval of approvals) {
            const notification = findApprovalNotification(notifications, approval);
            const notificationPending = notification?.status === "pending" ||
                (notification === undefined && approval.notification === "pending");
            const sortAt = time(approval.resolvedAt ?? approval.requestedAt);
            if (approval.status === "pending" && notificationPending) {
                push(approvalRequiredEvent(job, approval, emittedAt), time(approval.requestedAt));
                continue;
            }
            if (!isResolvedApproval(approval))
                continue;
            // A resolved approval with a pending notification is a legacy/stale
            // notification. It must be replayed even during an initial `--once`.
            // For a live watcher, includeResolved + since surfaces resolutions whose
            // state transition happened after the watcher started, including the
            // new atomically-acknowledged approval flow.
            const recentlyResolved = includeResolved && (since === undefined || sortAt >= since);
            if (!notificationPending && !recentlyResolved)
                continue;
            if (since !== undefined && notificationPending && sortAt < since && !includeResolved)
                continue;
            push(approvalResolvedEvent(job, approval, notification?.id ?? approval.notificationId, emittedAt), sortAt);
        }
        for (const request of job.hostAssistanceRequests ?? []) {
            const notification = notifications.find((candidate) => candidate.hostRequestId === request.id || candidate.id === request.notificationId);
            const notificationPending = notification?.status === "pending";
            if (request.status === "pending" && notificationPending) {
                const base = {
                    schema: JOB_EVENT_SCHEMA,
                    version: JOB_EVENT_VERSION,
                    eventId: request.notificationId,
                    emittedAt,
                    jobId: job.id,
                    notificationId: request.notificationId,
                    requestId: request.id,
                    generation: request.generation,
                    sessionId: request.sessionId,
                    attempt: request.attempt,
                    ...(request.perspective ? { perspective: publicText(request.perspective, 200) } : {}),
                    safeSummary: publicText(request.safeSummary, 500),
                    requestedAt: request.requestedAt,
                    expiresAt: request.expiresAt,
                };
                if (request.kind === "decision") {
                    push({ ...base, event: "human-decision-required" }, time(request.requestedAt));
                }
                else {
                    push({
                        ...base,
                        event: "host-assistance-required",
                        ...(request.contextClass ? { contextClass: request.contextClass } : {}),
                    }, time(request.requestedAt));
                }
                continue;
            }
            if (request.status === "pending" || !request.resolvedAt)
                continue;
            const resolvedAt = time(request.resolvedAt);
            const recentlyResolved = includeResolved && (since === undefined || resolvedAt >= since);
            if (!notificationPending && !recentlyResolved)
                continue;
            push({
                schema: JOB_EVENT_SCHEMA,
                version: JOB_EVENT_VERSION,
                eventId: `host-resolved:${request.id}:${request.resolvedAt}`,
                event: request.kind === "decision" ? "human-decision-resolved" : "host-assistance-resolved",
                emittedAt,
                jobId: job.id,
                notificationId: request.notificationId,
                requestId: request.id,
                generation: request.generation,
                status: request.status,
                resolvedAt: request.resolvedAt,
            }, resolvedAt);
        }
        if (includeProgress && !isTerminalStatus(job.status)) {
            const updatedAt = job.updatedAt ?? job.lastProgressAt ?? job.createdAt;
            const progressAt = time(updatedAt);
            if (since === undefined || progressAt >= since) {
                push({
                    schema: JOB_EVENT_SCHEMA,
                    version: JOB_EVENT_VERSION,
                    eventId: `progress:${job.id}:${updatedAt ?? job.status}`,
                    event: "job-progress",
                    emittedAt,
                    jobId: job.id,
                    status: String(job.status),
                    ...(job.phase ? { phase: job.phase } : {}),
                    ...(job.progressMessage
                        ? { progressMessage: publicText(job.progressMessage, 500) }
                        : {}),
                    ...(job.updatedAt ? { updatedAt: job.updatedAt } : {}),
                    ...(job.lastProgressAt ? { lastProgressAt: job.lastProgressAt } : {}),
                }, progressAt);
            }
        }
    }
    return projected
        .sort((left, right) => left.sortAt - right.sortAt || left.ordinal - right.ordinal)
        .map(({ event }) => event);
    function push(event, sortAt) {
        projected.push({ event, sortAt, ordinal: ordinal++ });
    }
}
/**
 * Return a polling snapshot. `pendingCount` only counts actionable or
 * unacknowledged notifications; progress events do not make a Host prompt.
 */
export function createJobEventSnapshot(state, options = {}) {
    const snapshotAt = iso(options.now ?? new Date());
    const events = projectJobEvents(state, { ...options, now: snapshotAt });
    const pendingCount = events.filter((event) => {
        if (event.event === "approval-required" ||
            event.event === "host-assistance-required" ||
            event.event === "human-decision-required")
            return true;
        if (event.event !== "approval-resolved" &&
            event.event !== "host-assistance-resolved" &&
            event.event !== "human-decision-resolved" &&
            event.event !== "job-terminal")
            return false;
        const job = state.jobs.find((candidate) => candidate.id === event.jobId);
        const notificationId = "notificationId" in event ? event.notificationId : undefined;
        const notification = notificationId
            ? job?.notifications?.find((candidate) => candidate.id === notificationId)
            : undefined;
        // Missing notification metadata is a legacy pending notification when the
        // event was projected from the Job-level pending marker.
        return notification?.status === "pending" || notification === undefined;
    }).length;
    return { snapshotAt, events, pendingCount };
}
/**
 * Filter events already observed by a watcher. The supplied Set is mutated so
 * it can be retained between 500ms polling passes. Event IDs are stable across
 * processes for approvals, terminals, and progress versions.
 */
export function dedupeJobEvents(events, seen = new Set()) {
    const fresh = [];
    for (const event of events) {
        if (seen.has(event.eventId))
            continue;
        seen.add(event.eventId);
        fresh.push(event);
    }
    return fresh;
}
export function createWatchReadyEvent(watcherId, replayCount, now = new Date()) {
    return {
        schema: JOB_EVENT_SCHEMA,
        version: JOB_EVENT_VERSION,
        eventId: `watch-ready:${watcherId}`,
        event: "watch-ready",
        emittedAt: iso(now),
        watcherId,
        replayCount,
    };
}
function approvalRequiredEvent(job, approval, emittedAt) {
    const decision = approval.decision;
    return {
        schema: JOB_EVENT_SCHEMA,
        version: JOB_EVENT_VERSION,
        eventId: approval.notificationId,
        event: "approval-required",
        emittedAt,
        jobId: job.id,
        notificationId: approval.notificationId,
        approvalId: approval.id,
        generation: approval.generation,
        toolName: publicText(approval.toolName, 200),
        actionSummary: publicText(approval.actionSummary, 2_000),
        risk: safeRisk(decision),
        capabilities: safeCapabilities(decision),
        reason: typeof decision.reason === "string"
            ? publicText(decision.reason, 2_000)
            : "Approval required.",
        requestedAt: approval.requestedAt,
        expiresAt: approval.expiresAt,
    };
}
function approvalResolvedEvent(job, approval, notificationId, emittedAt) {
    const resolvedAt = approval.resolvedAt ?? approval.requestedAt;
    return {
        schema: JOB_EVENT_SCHEMA,
        version: JOB_EVENT_VERSION,
        eventId: `approval:${approval.id}:${resolvedStatus(approval)}:${resolvedAt}`,
        event: "approval-resolved",
        emittedAt,
        jobId: job.id,
        approvalId: approval.id,
        notificationId,
        status: resolvedStatus(approval),
        resolvedAt,
    };
}
function resolvedStatus(approval) {
    if (approval.status === "approved" ||
        approval.status === "denied" ||
        approval.status === "expired" ||
        approval.status === "consumed") {
        return approval.status;
    }
    // This helper is only called after the projection has ruled out pending.
    // Keep the fallback conservative if malformed legacy state reaches here.
    return "expired";
}
function findApprovalNotification(notifications, approval) {
    return notifications.find((notification) => notification.kind === "approval" &&
        (notification.approvalId === approval.id || notification.id === approval.notificationId));
}
function isResolvedApproval(approval) {
    return approval.status !== "pending";
}
function safeRisk(decision) {
    return decision.risk === "low" ||
        decision.risk === "medium" ||
        decision.risk === "high" ||
        decision.risk === "critical"
        ? decision.risk
        : "high";
}
const CAPABILITIES = new Set([
    "filesystem.read-workspace",
    "filesystem.write-workspace",
    "filesystem.write-temp",
    "git.read",
    "shell.execute",
    "network.connect",
]);
function safeCapabilities(decision) {
    return Array.isArray(decision.capabilities)
        ? decision.capabilities.filter((capability) => CAPABILITIES.has(capability))
        : [];
}
// Approval summaries are generated from tool input. Apply a conservative
// value-level mask here so an otherwise allowlisted command cannot carry a
// bearer token, provider key, JWT, or URL userinfo across the Host boundary.
const EVENT_SECRET_PATTERNS = [
    /\bBearer\s+[A-Za-z0-9._~+/-]+/gi,
    /\bBasic\s+[A-Za-z0-9+/=]+/gi,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /\b(?:gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|xox[baprs]-[A-Za-z0-9-]+|AIza[0-9A-Za-z_-]{20,}|ya29\.[A-Za-z0-9._-]+|(?:AKIA|ASIA)[A-Z0-9]{16}|hf_[A-Za-z0-9]{20,}|pplx-[A-Za-z0-9-]{20,}|npm_[A-Za-z0-9]{20,}|lin_[A-Za-z0-9]{20,})\b/g,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    /(?:access|refresh|id)_?token\s*[:=]\s*\S+/gi,
    /(?:api[_-]?key|password|secret|authorization|cookie|credential|private[_-]?key)\s*[:=]\s*\S+/gi,
];
const EVENT_URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)(?!\[redacted\]@)[^\s/@:]+(?::[^\s/@]*)?@/gi;
const EVENT_ABSOLUTE_PATH = /\/(?:Users|home|private\/var|var\/folders|tmp)\/[^\s"'`]+/g;
function publicText(value, limit) {
    let output = value;
    for (const pattern of EVENT_SECRET_PATTERNS) {
        pattern.lastIndex = 0;
        output = output.replace(pattern, "[redacted]");
    }
    EVENT_URL_USERINFO.lastIndex = 0;
    output = output.replace(EVENT_URL_USERINFO, (_match, protocol) => `${protocol}[redacted]@`);
    EVENT_ABSOLUTE_PATH.lastIndex = 0;
    output = output.replace(EVENT_ABSOLUTE_PATH, "[path]");
    return output.slice(0, limit);
}
function isTerminalStatus(status) {
    return ["succeeded", "failed", "cancelled", "timed-out", "orphaned", "not-implemented"].includes(status);
}
function iso(value) {
    return typeof value === "string" ? value : value.toISOString();
}
function time(value) {
    if (value === undefined)
        return 0;
    const parsed = Date.parse(typeof value === "string" ? value : value.toISOString());
    return Number.isFinite(parsed) ? parsed : 0;
}
