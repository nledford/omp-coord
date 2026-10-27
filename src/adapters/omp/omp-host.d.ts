/**
 * The one module of omp's own that the extension imports at run time (see spawn-queue.ts). omp supplies it to
 * extensions by rewriting the import as it loads them; it is not a package dependency, so its type is declared here.
 */
declare module "@oh-my-pi/pi-coding-agent/config/registry" {
  import type { SettingHandle } from "./spawn-queue.ts";
  export function lookup(id: string): SettingHandle | undefined;
}
