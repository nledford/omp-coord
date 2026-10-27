import { describe, expect, test } from "bun:test";
import { loadSettingHandle, type SettingHandle, spawnQueue } from "../src/adapters/omp/spawn-queue.ts";

/** A setting handle as omp's registry gives it: a configured value, and a runtime override on top. */
function fakeHandle(configured?: number) {
  const writes: (number | undefined)[] = [];
  let override: number | undefined;
  const handle: SettingHandle = {
    get: () => override ?? configured ?? 32,
    override: (_scope, value) => {
      override = value;
      writes.push(value);
    },
    clearOverride: () => {
      override = undefined;
      writes.push(undefined);
    },
    isConfigured: () => configured !== undefined,
  };
  return { handle, writes, value: () => handle.get({}) };
}

describe("omp's spawn queue, driven by the caps", () => {
  test("the queue follows the allowance, written only when it changes", () => {
    const h = fakeHandle();
    const q = spawnQueue(h.handle, {});
    q?.apply(3);
    q?.apply(3);
    q?.apply(5);
    expect(h.writes).toEqual([3, 5]);
    expect(h.value()).toBe(5);
  });

  test("never 0, which omp reads as unlimited", () => {
    const h = fakeHandle();
    spawnQueue(h.handle, {})?.apply(0);
    expect(h.value()).toBe(1);
  });

  test("a value the user set is a ceiling; 0 (unlimited) or unset is none", () => {
    const own = fakeHandle(4);
    spawnQueue(own.handle, {})?.apply(8);
    expect(own.value()).toBe(4);
    const unlimited = fakeHandle(0);
    spawnQueue(unlimited.handle, {})?.apply(8);
    expect(unlimited.value()).toBe(8);
  });

  test("stopping gives the user's own value back, and only after the queue was ever set", () => {
    const h = fakeHandle(4);
    const q = spawnQueue(h.handle, {});
    q?.release();
    expect(h.writes).toEqual([]);
    q?.apply(2);
    q?.release();
    expect(h.value()).toBe(4);
    expect(h.writes).toEqual([2, undefined]);
  });

  test("without omp's setting handle or a settings scope nothing is driven", async () => {
    expect(spawnQueue(undefined, {})).toBeUndefined();
    expect(spawnQueue(fakeHandle().handle, undefined)).toBeUndefined();
    // outside omp (these tests) the registry can't be imported: no handle, a reason, no error
    expect(await loadSettingHandle()).toMatch(/can't be loaded/);
  });
});
