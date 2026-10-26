import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readQueue } from "../src/infra/flock-queues.ts";

test.skipIf(!Bun.which("flock"))("a slot shows as running only while a process holds its lock; tickets list in order of service", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-coord-q-"));
  mkdirSync(join(dir, "queue"));
  writeFileSync(join(dir, "1.lock"), "/w/one ci");
  writeFileSync(join(dir, "2.lock"), "/w/two ci (finished earlier)");
  writeFileSync(join(dir, "queue", `5-000000000200-${process.pid}`), "/w/three ci");
  writeFileSync(join(dir, "queue", "0-000000000300-999999"), "/w/four ci");

  // The holder waits on stdin, so the lock is held until the test closes it.
  const holder = Bun.spawn(["flock", join(dir, "1.lock"), "sh", "-c", "echo held; read _"], { stdin: "pipe", stdout: "pipe" });
  await holder.stdout.getReader().read();

  const view = await readQueue({ name: "heavy", dir, slots: 2 });
  expect(view.running).toEqual([{ slot: 1, holder: "/w/one ci" }]);
  expect(view.waiting.map(w => [w.ticket, w.holder, w.alive])).toEqual([
    ["0-000000000300-999999", "/w/four ci", false],
    [`5-000000000200-${process.pid}`, "/w/three ci", true],
  ]);

  holder.stdin.end();
  await holder.exited;
  expect((await readQueue({ name: "heavy", dir, slots: 2 })).running).toEqual([]);
});
