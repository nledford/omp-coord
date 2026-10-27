/**
 * Keeps omp's own per-session spawn queue (the `task.maxConcurrency` setting) at the number of this session's spawns
 * the caps let run now (`spawnAllowance`), so spawns past it wait in omp's queue and start as places free, instead of
 * reaching the spawn check and being refused.
 *
 * omp re-reads the setting at each acquire and release of a place in its queue, so a raised value admits waiting
 * spawns at the next start or end of one of this session's agents. A slot another session frees is therefore taken up
 * then, or by the held-slot notice; see docs/agent-slots.md.
 *
 * The setting is changed by a runtime override (never persisted) and cleared when the session stops. A value the user
 * set is a ceiling the override never exceeds. If omp's settings registry can't be loaded (an omp without it), nothing
 * changes and spawns are refused as before.
 */

/** The slice of omp's typed setting handle used here (`@oh-my-pi/pi-coding-agent/config/registry`). */
export interface SettingHandle {
  get(scope: unknown): unknown;
  override(scope: unknown, value: number | undefined): void;
  clearOverride(scope: unknown): void;
  isConfigured(scope: unknown): boolean;
}

export interface SpawnQueue {
  /** Sets the queue's size to `allowance`, capped by the user's own value; writes only when it changes. */
  apply(allowance: number): void;
  /** Removes the override, giving the session back the user's own value. */
  release(): void;
}

export const SETTING_ID = "task.maxConcurrency";
/** omp's settings registry, imported by name at run time (a constant, so the compiler doesn't look for it). */
const REGISTRY: string = "@oh-my-pi/pi-coding-agent/config/registry";

/** A queue driver over `handle` in `scope`; `undefined` when either is missing. */
export function spawnQueue(handle: SettingHandle | undefined, scope: unknown): SpawnQueue | undefined {
  if (!handle || scope === undefined) return undefined;
  // the user's own value, read before the first override: a positive number is a ceiling; 0 (unlimited) or unset is none
  const own = handle.isConfigured(scope) ? Number(handle.get(scope)) : 0;
  const ceiling = Number.isFinite(own) && own > 0 ? Math.trunc(own) : Number.POSITIVE_INFINITY;
  let last: number | undefined;
  return {
    apply(allowance) {
      // never 0: omp reads 0 as unlimited
      const value = Math.max(1, Math.min(Math.trunc(allowance), ceiling));
      if (value === last) return;
      handle.override(scope, value);
      last = value;
    },
    release() {
      if (last === undefined) return;
      handle.clearOverride(scope);
      last = undefined;
    },
  };
}

/** omp's handle for the setting, or `undefined` when this omp has no settings registry to load it from. */
export async function loadSettingHandle(): Promise<SettingHandle | undefined> {
  try {
    // Dynamic on purpose: the host's registry exists only inside an omp that has it. A static import would fail the
    // whole extension's load in an older omp, in the CLI and in tests, where this module is loaded without omp.
    const registry = (await import(REGISTRY)) as {
      lookup?: (id: string) => SettingHandle | undefined;
    };
    return registry.lookup?.(SETTING_ID);
  } catch {
    return undefined;
  }
}
