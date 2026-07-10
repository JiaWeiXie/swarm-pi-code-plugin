export async function executeSession(options) {
    let output = "";
    const unsubscribe = options.session.subscribe((event) => {
        if (event.type === "message_update" &&
            event.assistantMessageEvent?.type === "text_delta") {
            output += event.assistantMessageEvent.delta ?? "";
        }
    });
    try {
        await options.session.prompt(options.prompt);
        return result(options.kind, "succeeded", options.model, output.trim());
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return result(options.kind, "failed", options.model, message);
    }
    finally {
        unsubscribe();
        options.session.dispose();
    }
}
export function notImplementedResult(kind) {
    return result(kind, "not-implemented", null, `${kind} is not enabled until its safety boundary is implemented.`);
}
function result(kind, status, model, output) {
    return {
        kind,
        status,
        success: status === "succeeded",
        model,
        output,
        changedFiles: [],
        diffStat: "",
        verification: {
            status: "not-run",
            commands: [],
        },
    };
}
