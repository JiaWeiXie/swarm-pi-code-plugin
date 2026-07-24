/** Same-session frontier reconnaissance followed by a mechanical executor. */
export function createPrewalkController(options) {
    const metadata = {
        status: "not-started",
        guideModel: options.guideModel,
        executorModel: options.executorModel,
        todoCount: 0,
    };
    let session;
    let todos = [];
    let switched = false;
    const tool = {
        name: "update_todo",
        description: "Maintain 1-8 concise implementation TODOs; each requires a verification condition.",
        parameters: {
            type: "object",
            additionalProperties: false,
            required: ["items"],
            properties: {
                items: {
                    type: "array",
                    minItems: 1,
                    maxItems: 8,
                    items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["task", "verification", "status"],
                        properties: {
                            task: { type: "string", minLength: 1, maxLength: 500 },
                            verification: { type: "string", minLength: 1, maxLength: 500 },
                            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                        },
                    },
                },
            },
        },
        async execute(_callId, params) {
            todos = params.items;
            metadata.todoCount = todos.length;
            return { content: [{ type: "text", text: `Recorded ${todos.length} TODO items.` }] };
        },
    };
    return {
        tool,
        metadata,
        attach(candidate) {
            session = candidate;
        },
        async onWorkspaceMutation() {
            if (switched)
                return;
            if (todos.length < 1 || todos.length > 8) {
                metadata.status = "switch-failed";
                metadata.switchFailure = "missing-todos";
                throw new Error("Prewalk requires 1-8 TODO items before its first workspace mutation.");
            }
            if (!session?.setModel) {
                metadata.status = "switch-failed";
                metadata.switchFailure = "switch-error";
                throw new Error("Prewalk session does not support an in-session model switch.");
            }
            try {
                pruneGuideInstruction(session.agent?.state?.messages);
                await session.setModel(options.executorModelObject);
                session.setThinkingLevel?.(options.executorThinkingLevel);
                switched = true;
                metadata.status = "switched";
                metadata.handoffAt = new Date().toISOString();
            }
            catch (error) {
                metadata.status = "switch-failed";
                metadata.switchFailure = "switch-error";
                throw error;
            }
        },
        finalize() {
            if (!switched && metadata.status === "not-started") {
                metadata.status = "incomplete";
                metadata.switchFailure = todos.length ? "missing-mutation" : "missing-todos";
            }
        },
    };
}
function pruneGuideInstruction(messages) {
    for (const message of messages ?? []) {
        if (!message || typeof message !== "object")
            continue;
        const record = message;
        if (typeof record.content === "string")
            record.content = record.content.replace(/\[PREWALK_GUIDE\][\s\S]*?\[\/PREWALK_GUIDE\]\n?/g, "");
    }
}
