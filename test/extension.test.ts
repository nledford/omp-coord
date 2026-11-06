import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentIdentity, ExtensionAPI, ExtensionContext, ToolResult } from "../src/adapters/omp/api.ts";
import ompCoord from "../src/adapters/omp/extension.ts";
import { osLoad } from "../src/adapters/os/load.ts";
import { BoardStore, stateDir } from "../src/adapters/sqlite/store.ts";
import { unixLiveness } from "../src/adapters/unix/beacon.ts";
import { Coordinator } from "../src/app/coordinator.ts";
import { loadConfig } from "../src/config.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(id: string, params: never, signal: undefined, onUpdate: unknown, ctx: ExtensionContext): Promise<ToolResult>;
}

/** One omp session's binding of the extension: what it registered, and what it was asked to send. */
function binding() {
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, Handler[]>();
  const sent: string[] = [];
  const schema = (type: string) => {
    const field = { type, optional: false, text: "" };
    return Object.assign(field, {
      describe(text: string) {
        field.text = text;
        return field;
      },
      optional() {
        field.optional = true;
        return field;
      },
    });
  };
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    setLabel: () => {},
    registerTool: (tool: Tool) => {
      if (tools.has(tool.name)) throw new Error(`${tool.name} registered twice`);
      tools.set(tool.name, tool);
    },
    registerCommand: () => {},
    sendMessage: (message: { content: string }) => sent.push(message.content),
    zod: {
      object: (shape: Record<string, unknown>) => shape,
      string: () => schema("string"),
      number: () => schema("number"),
      boolean: () => schema("boolean"),
    },
  } as unknown as ExtensionAPI;
  const fire = async (event: string, ctx: ExtensionContext, payload: unknown = {}) => {
    let result: unknown;
    for (const handler of handlers.get(event) ?? []) result = (await handler(payload, ctx)) ?? result;
    return result;
  };
  return { pi, tools, sent, fire, names: () => [...tools.keys()].sort() };
}

describe("the omp adapter's tools", () => {
  let folder: string;
  let state: string;
  let timers: (() => void | Promise<void>)[];
  let started: ReturnType<typeof binding> | undefined;
  const saved = process.env.OMP_COORD_STATE_DIR;

  const ctxOf = (agent: AgentIdentity): ExtensionContext =>
    ({
      get cwd() {
        return folder;
      },
      mode: "print",
      hasUI: false,
      agent,
      ui: { notify: () => {}, setStatus: () => {} },
      isIdle: () => true,
      setInterval: (fn: () => void | Promise<void>) => timers.push(fn),
      clearTimer: () => {},
    }) as unknown as ExtensionContext;
  const main = ctxOf({ kind: "main", id: "Main", name: "main", depth: 0 });
  const sub = ctxOf({ kind: "sub", id: "Fixer", name: "task", depth: 1, parentId: "Main" });

  beforeEach(() => {
    started = undefined;
    folder = mkdtempSync(join(tmpdir(), "omp-coord-ext-"));
    state = join(folder, "state");
    mkdirSync(state);
    process.env.OMP_COORD_STATE_DIR = state;
    timers = [];
    writeFileSync(
      join(folder, ".omp-coord.json"),
      JSON.stringify({ scope: "ext", agents: { pools: { work: { cap: 2 } }, queueSpawns: false } }),
    );
  });

  afterEach(async () => {
    // the runtime lives on globalThis: a test that fails midway must not leave its session for the next one
    if (started) await started.fire("session_shutdown", main);
    if (saved === undefined) delete process.env.OMP_COORD_STATE_DIR;
    else process.env.OMP_COORD_STATE_DIR = saved;
    rmSync(folder, { recursive: true, force: true });
  });

  /** The main session, started and registered, and a subagent's binding; shut down after the test. */
  async function sessions() {
    const m = binding();
    ompCoord(m.pi);
    const s = binding();
    ompCoord(s.pi);
    started = m;
    const before = m.names();
    await m.fire("session_start", main);
    await s.fire("session_start", sub);
    return { m, s, before };
  }

  /** A second session of the scope, as another omp process would be: it sends messages and holds claims. */
  function peer() {
    const store = new BoardStore(join(stateDir(), "ext.db"));
    const coordinator = new Coordinator(loadConfig(join(folder, ".omp-coord.json")), store, unixLiveness, Date, osLoad);
    coordinator.join({ id: "peer", pid: process.pid, cwd: folder, address: join(folder, "peer.sock") });
    return { coordinator, close: () => store.close() };
  }

  const textOf = (result: ToolResult) => result.content[0]?.text ?? "";

  test("only coord_status and coord_resources exist before the main session starts and in a subagent", async () => {
    const { m, s, before } = await sessions();
    expect(before).toEqual(["coord_resources", "coord_status"]);
    expect(s.names()).toEqual(["coord_resources", "coord_status"]);
    expect(m.names()).toEqual([
      "coord_claim",
      "coord_job_priority",
      "coord_note",
      "coord_release",
      "coord_resources",
      "coord_send",
      "coord_status",
    ]);
  });

  test("a repeated session_start of the main session registers the main-only tools once", async () => {
    const { m } = await sessions();
    await m.fire("session_start", main);
    expect(m.names()).toHaveLength(7);
  });

  test("every tool description is one short line", async () => {
    const { m } = await sessions();
    for (const tool of m.tools.values()) {
      expect(tool.description, tool.name).not.toContain("\n");
      expect(tool.description.length, tool.name).toBeLessThanOrEqual(170);
    }
  });

  describe("coord_status", () => {
    async function withNotes(count: number) {
      const sessionsStarted = await sessions();
      const note = sessionsStarted.m.tools.get("coord_note") as Tool;
      for (let i = 1; i <= count; i++)
        await note.execute("t", { text: `decision ${i}` } as never, undefined, undefined, main);
      const tool = sessionsStarted.m.tools.get("coord_status") as Tool;
      const run = (params: object, ctx: ExtensionContext) =>
        tool.execute("t", params as never, undefined, undefined, ctx);
      return { run, status: async (params: object, ctx: ExtensionContext) => textOf(await run(params, ctx)) };
    }

    test("the main session sees the 3 latest decisions and the folder of each session by default", async () => {
      const { status } = await withNotes(4);
      const text = await status({}, main);
      expect(text).toContain("decision 4");
      expect(text).toContain("decision 2");
      expect(text).not.toContain("decision 1");
      expect(text).toContain(folder);
      expect(text).toContain("Spawns past the cap");
    });

    test("a subagent sees no decisions and a compact overview by default", async () => {
      const { status } = await withNotes(4);
      const text = await status({}, sub);
      expect(text).not.toContain("decision");
      expect(text).not.toContain("Latest decisions");
      expect(text).not.toContain(folder);
      expect(text).not.toContain("Spawns past the cap");
      expect(text).toContain("A (this session): no agents");
      expect(text).toContain("Agent slots: work 0/2");
    });

    test("notes and compact override the defaults of either kind of session", async () => {
      const { status } = await withNotes(4);
      const asSub = await status({ notes: 1, compact: false }, sub);
      expect(asSub).toContain("decision 4");
      expect(asSub).not.toContain("decision 3");
      expect(asSub).toContain(folder);
      const asMain = await status({ notes: 0, compact: true }, main);
      expect(asMain).not.toContain("decision");
      expect(asMain).not.toContain(folder);
    });

    test("a negative or fractional notes count is refused, naming the rule", async () => {
      const { run } = await withNotes(0);
      for (const notes of [-1, 1.5]) {
        const result = await run({ notes }, main);
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("notes must be a whole number");
      }
    });
  });

  describe("a claim held by another session", () => {
    async function refusalFor(agent: ExtensionContext) {
      const { m, s } = await sessions();
      const other = peer();
      try {
        expect(
          other.coordinator.claim({
            sessionId: "peer",
            agentId: "Main",
            kind: "branch",
            target: "fix-x",
            note: "",
            cwd: folder,
          }),
        ).toEqual({ ok: true });
        const caller = agent === main ? m : s;
        const result = await caller.fire("tool_call", agent, {
          toolName: "bash",
          input: { command: "git checkout fix-x" },
        });
        return result as { block: boolean; reason: string };
      } finally {
        other.close();
      }
    }

    test("refuses the main session's git command and points it to coord_send", async () => {
      const refusal = await refusalFor(main);
      expect(refusal.block).toBe(true);
      expect(refusal.reason).toContain("claimed by session B");
      expect(refusal.reason).toContain("ask that session with coord_send");
    });

    test("refuses a subagent's git command without naming a tool it does not have", async () => {
      const refusal = await refusalFor(sub);
      expect(refusal.block).toBe(true);
      expect(refusal.reason).toContain("claimed by session B");
      expect(refusal.reason).not.toContain("coord_send");
      expect(refusal.reason).toContain("tell your parent");
    });
  });

  describe("a message for a subagent", () => {
    test("does not tell it to answer with coord_send, which it does not have", async () => {
      const { s, m } = await sessions();
      const other = peer();
      try {
        const sendTo = (to: string) => other.coordinator.send("peer", to, "rebase onto main first");
        expect(sendTo("A/Fixer")).toMatchObject({ ok: true });
        expect(sendTo("A")).toMatchObject({ ok: true });
        for (const tick of timers) await tick();
        const toSub = s.sent.join("\n");
        expect(toSub).toContain("rebase onto main first");
        expect(toSub).not.toContain("coord_send");
        expect(toSub).toContain("tell your parent");
        expect(m.sent.join("\n")).toContain("reply with coord_send to B");
      } finally {
        other.close();
      }
    });
  });

  describe("a refused spawn", () => {
    test("says it did not start, and the hold notice names the agent to start again", async () => {
      const { m } = await sessions();
      const other = peer();
      try {
        for (const id of ["P1", "P2"]) {
          const ask = { sessionId: "peer", parentAgentId: "Main", parentIsSubagent: false, agentType: "task" };
          expect(other.coordinator.requestSpawn({ ...ask, spawnKey: id }).allowed).toBe(true);
          other.coordinator.agentStarted({ ...ask, agentId: id, parentId: "Main" });
        }
        const refusal = (await m.fire("before_subagent_spawn", main, { agent: "task", spawnKey: "CatalogTests" })) as {
          block: boolean;
          reason: string;
        };
        expect(refusal.block).toBe(true);
        expect(refusal.reason).toContain("This spawn did NOT start");

        other.coordinator.agentEnded({ sessionId: "peer", agentId: "P1" });
        for (const tick of timers) await tick();
        const notice = m.sent.join("\n");
        expect(notice).toContain("slot is free and held for this session");
        expect(notice).toContain("start the task agent CatalogTests that was refused again now");
      } finally {
        other.close();
      }
    });
  });
});
