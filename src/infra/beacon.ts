/**
 * Session liveness. Each session listens on a Unix socket for as long as its process lives; the kernel closes it
 * when the process dies, however it dies. Another session that cannot connect knows the session is gone. Unlike a
 * PID check, a reused PID cannot make a dead session look alive.
 */
import { rmSync } from "node:fs";

export interface Beacon {
  readonly path: string;
  stop(): void;
}

export function startBeacon(path: string): Beacon {
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
    path,
    stop() {
      listener.stop(true);
      rmSync(path, { force: true });
    },
  };
}

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
