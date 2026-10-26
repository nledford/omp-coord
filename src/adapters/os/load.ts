/** `LoadProbe` from the operating system's 1-minute load average (none on Windows). */
import { loadavg } from "node:os";
import type { LoadProbe } from "../../app/ports.ts";

export const osLoad: LoadProbe = {
  load: () => (process.platform === "win32" ? undefined : Math.round((loadavg()[0] ?? 0) * 10) / 10),
};
