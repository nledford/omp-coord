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
  const fire = async (event: string, ctx: ExtensionContext) => {
    for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
  };
  return { pi, tools, sent, fire, names: () => [...tools.keys()].sort() };
}

describe("the omp adapter's tools", () => {
  let folder: string;
  let state: string;
  let timers: (() => void | Promise<void>)[];
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

  afterEach(() => {
    if (saved === undefined) delete process.env.OMP_COORD_STATE_DIR;
    else process.env.OMP_COORD_STATE_DIR = saved;
    rmSync(folder, { recursive: true, force: true });
  });

  /** The main session, started and registered, and a subagent's binding; shut down at the end of the test. */
  async function sessions() {
    const m = binding();
    ompCoord(m.pi);
    const s = binding();
    ompCoord(s.pi);
    await m.fire("session_start", main);
    await s.fire("session_start", sub);
    return { m, s, stop: () => m.fire("session_shutdown", main) };
  }

  test("only coord_status and coord_resources exist before the session starts and in a subagent", async () => {
    const { m, s, stop } = await sessions();
    try {
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
    } finally {
      await stop();
    }
  });

  test("a repeated session_start of the main session registers the main-only tools once", async () => {
    const { m, stop } = await sessions();
    try {
      await m.fire("session_start", main);
      expect(m.names()).toHaveLength(7);
    } finally {
      await stop();
    }
  });

  test("every tool description is one line", async () => {
    const { m, stop } = await sessions();
    try {
      for (const tool of m.tools.values()) {
        expect(tool.description, tool.name).not.toContain("\n");
        expect(tool.description.length, tool.name).toBeLessThanOrEqual(170);
      }
    } finally {
      await stop();
    }
  });

  describe("coord_status", () => {
    async function withNotes(count: number) {
      const started = await sessions();
      const note = started.m.tools.get("coord_note") as Tool;
      for (let i = 1; i <= count; i++)
        await note.execute("t", { text: `decision ${i}` } as never, undefined, undefined, main);
      const statusTool = started.m.tools.get("coord_status") as Tool;
      const status = async (params: object, ctx: ExtensionContext) =>
        (await statusTool.execute("t", params as never, undefined, undefined, ctx)).content[0]?.text ?? "";
      return { ...started, status };
    }

    test("the main session sees the 3 latest decisions and the folder of each session by default", async () => {
      const { status, stop } = await withNotes(4);
      try {
        const text = await status({}, main);
        expect(text).toContain("decision 4");
        expect(text).toContain("decision 2");
        expect(text).not.toContain("decision 1");
        expect(text).toContain(folder);
        expect(text).toContain("Spawns past the cap");
      } finally {
        await stop();
      }
    });

    test("a subagent sees no decisions and a compact overview by default", async () => {
      const { status, stop } = await withNotes(4);
      try {
        const text = await status({}, sub);
        expect(text).not.toContain("decision");
        expect(text).not.toContain("Latest decisions");
        expect(text).not.toContain(folder);
        expect(text).not.toContain("Spawns past the cap");
        expect(text).toContain("A (this session): no agents");
        expect(text).toContain("Agent slots: work 0/2");
      } finally {
        await stop();
      }
    });

    test("notes and compact override the defaults of either kind of session", async () => {
      const { status, stop } = await withNotes(4);
      try {
        const asSub = await status({ notes: 1, compact: false }, sub);
        expect(asSub).toContain("decision 4");
        expect(asSub).not.toContain("decision 3");
        expect(asSub).toContain(folder);
        const asMain = await status({ notes: 0, compact: true }, main);
        expect(asMain).not.toContain("decision");
        expect(asMain).not.toContain(folder);
      } finally {
        await stop();
      }
    });

    test("a negative or fractional notes count is refused", async () => {
      const { m, stop } = await sessions();
      try {
        const tool = m.tools.get("coord_status") as Tool;
        for (const notes of [-1, 1.5]) {
          const result = await tool.execute("t", { notes } as never, undefined, undefined, main);
          expect(result.isError).toBe(true);
        }
      } finally {
        await stop();
      }
    });
  });

  describe("a message for a subagent", () => {
    test("does not tell it to answer with coord_send, which it does not have", async () => {
      const { s, m, stop } = await sessions();
      const other = new BoardStore(join(stateDir(), "ext.db"));
      try {
        const peer = new Coordinator(loadConfig(join(folder, ".omp-coord.json")), other, unixLiveness, Date, osLoad);
        peer.join({ id: "peer", pid: process.pid, cwd: folder, address: join(folder, "peer.sock") });
        const sendTo = (to: string) => peer.send("peer", to, "rebase onto main first");
        expect(sendTo("A/Fixer")).toMatchObject({ ok: true });
        expect(sendTo("A")).toMatchObject({ ok: true });
        for (const tick of timers) await tick();
        const toSub = s.sent.join("\n");
        expect(toSub).toContain("rebase onto main first");
        expect(toSub).not.toContain("coord_send");
        expect(toSub).toContain("tell your parent");
        const toMain = m.sent.join("\n");
        expect(toMain).toContain("reply with coord_send to B");
      } finally {
        other.close();
        await stop();
      }
    });
  });
});
