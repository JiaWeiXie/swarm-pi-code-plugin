import type { ThinkingLevel } from "../core/contracts.js";

type Todo = { task: string; verification: string; status: "pending" | "in_progress" | "completed" };

export interface PrewalkController {
  readonly tool: unknown;
  readonly metadata: {
    status: "not-started" | "switched" | "switch-failed" | "incomplete";
    guideModel: string;
    executorModel: string;
    handoffAt?: string;
    todoCount: number;
    switchFailure?: "same-model" | "missing-todos" | "missing-mutation" | "switch-error";
  };
  attach(session: unknown): void;
  assertBashAllowed(): void;
  beforeWorkspaceMutation(): Promise<void>;
  onWorkspaceMutation(): Promise<void>;
  finalize(): void;
}

type SwitchableSession = {
  setModel?: (model: unknown) => Promise<void>;
  setThinkingLevel?: (level: ThinkingLevel) => void;
  agent?: { state?: { messages?: unknown[] } };
};

/** Same-session frontier reconnaissance followed by a mechanical executor. */
export function createPrewalkController(options: {
  guideModel: string;
  executorModel: string;
  executorModelObject: unknown;
  executorThinkingLevel: ThinkingLevel;
}): PrewalkController {
  const metadata: PrewalkController["metadata"] = {
    status: "not-started",
    guideModel: options.guideModel,
    executorModel: options.executorModel,
    todoCount: 0,
  };
  let session: SwitchableSession | undefined;
  let todos: Todo[] = [];
  let switched = false;
  const tool = {
    name: "update_todo",
    description:
      "Maintain 1-8 concise implementation TODOs; each requires a verification condition.",
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
    async execute(_callId: string, params: { items: Todo[] }) {
      todos = params.items;
      metadata.todoCount = todos.length;
      return { content: [{ type: "text", text: `Recorded ${todos.length} TODO items.` }] };
    },
  };
  return {
    tool,
    metadata,
    attach(candidate) {
      session = candidate as SwitchableSession;
    },
    assertBashAllowed() {
      if (!switched) {
        throw new Error(
          "Prewalk guide phase does not allow Bash before the first TODO-gated workspace mutation and same-session executor handoff.",
        );
      }
    },
    async beforeWorkspaceMutation() {
      if (switched) return;
      assertTodoGate();
    },
    async onWorkspaceMutation() {
      if (switched) return;
      assertTodoGate();
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
      } catch (error) {
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

  function assertTodoGate(): void {
    if (todos.length < 1 || todos.length > 8) {
      metadata.status = "switch-failed";
      metadata.switchFailure = "missing-todos";
      throw new Error("Prewalk requires 1-8 TODO items before its first workspace mutation.");
    }
  }
}

export function withPrewalkBashGate(
  definition: unknown,
  controller: Pick<PrewalkController, "assertBashAllowed">,
): unknown {
  const tool = definition as { name?: unknown; execute: (...args: unknown[]) => unknown };
  return {
    ...tool,
    async execute(...args: unknown[]) {
      controller.assertBashAllowed();
      return tool.execute(...args);
    },
  };
}

function pruneGuideInstruction(messages: unknown[] | undefined): void {
  for (const message of messages ?? []) {
    if (!message || typeof message !== "object") continue;
    const record = message as { content?: unknown };
    if (typeof record.content === "string")
      record.content = record.content.replace(
        /\[PREWALK_GUIDE\][\s\S]*?\[\/PREWALK_GUIDE\]\n?/g,
        "",
      );
  }
}
