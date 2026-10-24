import assert from "node:assert/strict";

/** Only watchdog time is mocked; native AbortSignal provides a bounded test-harness timeout. */
export async function manualDeadlines(run: (fire: (ms: number) => Promise<void>) => Promise<void>) {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const timers = new Map<object, { ms: number; callback: () => void }>();
  const armed = new Map<number, () => void>();
  globalThis.setTimeout = ((callback: () => void, ms: number) => {
    const timer = { unref() {} };
    timers.set(timer, { ms, callback });
    armed.get(ms)?.();
    armed.delete(ms);
    return timer;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((timer: object) =>
    timers.delete(timer)) as unknown as typeof clearTimeout;
  try {
    await run(async (ms) => {
      if (![...timers.values()].some((timer) => timer.ms === ms)) {
        await new Promise<void>((resolve, reject) => {
          const signal = AbortSignal.timeout(90_000);
          const expired = () => reject(new Error(`Watchdog ${ms} was never armed.`));
          signal.addEventListener("abort", expired, { once: true });
          armed.set(ms, () => {
            signal.removeEventListener("abort", expired);
            resolve();
          });
        });
      }
      const timer = [...timers].find(([, value]) => value.ms === ms);
      assert(timer, `Watchdog ${ms} must be armed before firing.`);
      timers.delete(timer[0]);
      timer[1].callback();
    });
    assert.equal(timers.size, 0, "request left an armed deadline");
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
}
