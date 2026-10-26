/**
 * Liveness over Unix sockets. Each session and each queued job listens on a socket for as long as its process lives;
 * the kernel closes it when the process dies, however it dies. A process that cannot connect knows the other is gone.
 * Unlike a PID check, a reused PID cannot make a dead process look alive.
 */
import { rmSync } from "node:fs";
import type { Listener, Liveness } from "../../app/ports.ts";

export function startBeacon(path: string): Listener {
  rmSync(path, { force: true });
  const listener = Bun.listen({
    unix: path,
    socket: {
      open(socket) {
        socket.end("ok\n");
      },
      data() {},
    },
  });
  return {
    address: path,
    stop() {
      listener.stop(true);
      rmSync(path, { force: true });
    },
  };
}

export const unixLiveness: Liveness = {
  isAlive: path => isAlive(path),
  forget: path => rmSync(path, { force: true }),
};

/**
 * False only when the socket is certainly dead (missing, or nothing listening). Any other failure or a slow answer
 * counts as alive, so a transient error (too many open files, a busy machine) never evicts a live session.
 */
export async function isAlive(path: string, timeoutMs = 1500): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => resolve(true), timeoutMs);
  try {
    const socket = await Bun.connect({
      unix: path,
      socket: {
        data() {},
        open(s) {
          s.end();
          resolve(true);
        },
        connectError(_s, error) {
          resolve(!isDeadSocketError(error));
        },
        error() {},
      },
    });
    void socket;
  } catch (error) {
    resolve(!isDeadSocketError(error));
  }
  const alive = await promise;
  clearTimeout(timer);
  return alive;
}

function isDeadSocketError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return code === "ENOENT" || code === "ECONNREFUSED";
}
