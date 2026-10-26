/**
 * Whether a process group still has a member that has not exited, for stopping a timed-out job's whole group.
 *
 * A signal to the group succeeds while it holds only zombies, which is what an exited command's children become in a
 * container whose first process never reaps orphans. On Linux, /proc tells them apart. Elsewhere (macOS has no /proc;
 * launchd reaps orphans), or when /proc cannot be read, the signal decides.
 */
import { readdirSync, readFileSync } from "node:fs";

/** The state and process group of a process, from the text of `/proc/<pid>/stat`. */
export function parseProcStat(stat: string): { state: string; pgrp: number } | undefined {
  // "pid (comm) state ppid pgrp …": comm may contain spaces and parentheses, so fields start after the last ")".
  const close = stat.lastIndexOf(")");
  if (close === -1) return undefined;
  const [state, , pgrp] = stat.slice(close + 2).split(" ");
  const group = Number(pgrp);
  return state && Number.isInteger(group) ? { state, pgrp: group } : undefined;
}

export function groupRunning(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") return true;
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter(entry => /^\d+$/.test(entry));
  } catch {
    return true;
  }
  for (const pid of pids) {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
      continue; // ended while being read, or hidden
    }
    const p = parseProcStat(stat);
    if (p?.pgrp === pgid && p.state !== "Z") return true;
  }
  return false;
}
