import { describe, expect, it } from "vitest";
import { CooldownActiveError, DailyCapReachedError } from "./errors";
import { MemoryUsageCounter, createThrottle, pollDelayMs } from "./throttle";
import { fakeClock } from "./testing";

describe("throttle", () => {
  it("serializes per account and keeps a 1.5–4 s gap", async () => {
    for (const r of [0, 0.5, 0.999999]) {
      const clock = fakeClock();
      const sleeps: number[] = [];
      const t = createThrottle({ now: clock.now, random: () => r, sleep: async (ms) => { sleeps.push(ms); await clock.sleep(ms); } });
      const order: string[] = [];
      let running = 0;
      const job = (n: string) => async () => {
        running++;
        expect(running).toBe(1);
        order.push(`start${n}`);
        await Promise.resolve();
        clock.advance(100);
        order.push(`end${n}`);
        running--;
      };
      await Promise.all([t.schedule("a", job("1")), t.schedule("a", job("2")), t.schedule("a", job("3"))]);
      expect(order).toEqual(["start1", "end1", "start2", "end2", "start3", "end3"]);
      expect(sleeps).toHaveLength(2);
      for (const s of sleeps) {
        expect(s).toBeGreaterThanOrEqual(1500);
        expect(s).toBeLessThanOrEqual(4000);
      }
    }
  });

  it("a failing task does not block the queue", async () => {
    const clock = fakeClock();
    const t = createThrottle({ now: clock.now, sleep: clock.sleep });
    await expect(t.schedule("a", async () => { throw new Error("x"); })).rejects.toThrow("x");
    await expect(t.schedule("a", async () => 7)).resolves.toBe(7);
  });

  it("enforces daily caps (default audio 2) and never runs the task", async () => {
    const clock = fakeClock();
    const usage = new MemoryUsageCounter();
    const t = createThrottle({ now: clock.now, sleep: clock.sleep, usage });
    let runs = 0;
    const fn = async () => { runs++; };
    await t.schedule("a", fn, { usageKind: "audio" });
    await t.schedule("a", fn, { usageKind: "audio" });
    await expect(t.schedule("a", fn, { usageKind: "audio" })).rejects.toBeInstanceOf(DailyCapReachedError);
    expect(runs).toBe(2);
    await t.schedule("b", fn, { usageKind: "audio" }); // per account
    clock.advance(24 * 3600_000);
    await t.schedule("a", fn, { usageKind: "audio" }); // next UTC day
    const t2 = createThrottle({ now: clock.now, sleep: clock.sleep, usage, caps: { chat: 1 } });
    await t2.schedule("c", fn, { usageKind: "chat" });
    await expect(t2.schedule("c", fn, { usageKind: "chat" })).rejects.toMatchObject({ cap: 1 });
  });

  it("cools down after quota, honours Retry-After, grows exponentially, capped", async () => {
    const clock = fakeClock();
    const t = createThrottle({ now: clock.now, sleep: clock.sleep, backoffBaseMs: 1000, backoffMaxMs: 10_000 });
    expect(t.noteQuota("a", 5)).toBe(5000);
    await expect(t.schedule("a", async () => 1)).rejects.toBeInstanceOf(CooldownActiveError);
    clock.advance(5000);
    await expect(t.schedule("a", async () => 1)).resolves.toBe(1);
    expect(t.noteQuota("a")).toBe(2000);
    expect(t.noteQuota("a")).toBe(4000);
    expect(t.noteQuota("a")).toBe(8000);
    expect(t.noteQuota("a")).toBe(10_000);
    expect(t.noteQuota("a", 999)).toBe(10_000);
    t.noteSuccess("a");
    expect(t.noteQuota("a")).toBe(1000);
  });

  it("polling floor is 15 s", () => {
    expect(pollDelayMs(1000)).toBe(15_000);
    expect(pollDelayMs(30_000)).toBe(30_000);
    expect(pollDelayMs()).toBe(15_000);
  });
});
