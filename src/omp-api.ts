/**
 * The part of omp's extension API this extension uses (omp 18.12; documented in omp's `extensions.md`). Declared
 * here rather than imported so the extension type-checks without a matching `@oh-my-pi/pi-coding-agent` install.
 */

export interface AgentIdentity {
  kind: "main" | "sub";
  id: string;
  /** Lowercased agent definition name (`task`, `scout`, `reviewer`…). */
  name: string;
  depth: number;
  parentId?: string;
}

export type Timer = unknown;

export interface ExtensionContext {
  cwd: string;
  mode: "tui" | "rpc" | "json" | "print";
  hasUI: boolean;
  agent: AgentIdentity;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus(key: string, text: string | undefined): void;
  };
  isIdle(): boolean;
  setInterval(fn: () => void | Promise<void>, ms: number): Timer;
  clearTimer(timer: Timer): void;
}

export interface SpawnEvent {
  agent: string;
  invocationKind?: string;
  modelRole?: string;
  spawnKey?: string;
}

export interface ToolCallEvent {
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  details?: unknown;
  isError?: boolean;
}

export type Block = { block: true; reason: string } | undefined;

export interface Events {
  session_start: (event: unknown, ctx: ExtensionContext) => unknown;
  session_shutdown: (event: unknown, ctx: ExtensionContext) => unknown;
  agent_start: (event: unknown, ctx: ExtensionContext) => unknown;
  agent_end: (event: unknown, ctx: ExtensionContext) => unknown;
  before_subagent_spawn: (event: SpawnEvent, ctx: ExtensionContext) => Block | Promise<Block>;
  tool_call: (event: ToolCallEvent, ctx: ExtensionContext) => Block | Promise<Block>;
}

export interface ZodString {
  describe(description: string): ZodString;
}

export interface ExtensionAPI {
  on<K extends keyof Events>(event: K, handler: Events[K]): void;
  setLabel(label: string): void;
  registerTool<P>(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(toolCallId: string, params: P, signal: AbortSignal | undefined, onUpdate: unknown, ctx: ExtensionContext): Promise<ToolResult>;
  }): void;
  registerCommand(name: string, options: { description: string; handler(args: string, ctx: ExtensionContext): Promise<void> | void }): void;
  sendMessage(
    message: { customType: string; content: string; display: boolean; attribution: "agent" | "user" },
    options: { deliverAs?: "steer" | "followUp" | "nextTurn" | "aside"; triggerTurn?: boolean },
  ): void;
  zod: {
    object(shape: Record<string, ZodString>): unknown;
    string(): ZodString;
  };
}
