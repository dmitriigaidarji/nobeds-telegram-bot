/**
 * The queue that keeps a manual /poll from overlapping the scheduled one.
 * Overlap is the failure that would send every notification twice.
 */
import { describe, expect, test } from "bun:test";
import { createSerialQueue } from "../src/serial.ts";

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createSerialQueue", () => {
  test("never runs two tasks at the same time", async () => {
    const serialise = createSerialQueue();
    let running = 0;
    let overlapped = false;

    const task = async () => {
      running += 1;
      if (running > 1) overlapped = true;
      await tick();
      running -= 1;
    };

    await Promise.all([serialise(task), serialise(task), serialise(task)]);

    expect(overlapped).toBe(false);
    expect(running).toBe(0);
  });

  test("preserves submission order", async () => {
    const serialise = createSerialQueue();
    const order: number[] = [];

    await Promise.all(
      [30, 1, 10].map((delay, index) =>
        serialise(async () => {
          await tick(delay);
          order.push(index);
        }),
      ),
    );

    expect(order).toEqual([0, 1, 2]);
  });

  test("returns each task's own value", async () => {
    const serialise = createSerialQueue();
    const results = await Promise.all([
      serialise(async () => "a"),
      serialise(async () => "b"),
    ]);
    expect(results).toEqual(["a", "b"]);
  });

  test("a failing task rejects its caller without wedging the queue", async () => {
    const serialise = createSerialQueue();

    const failing = serialise(async () => {
      throw new Error("poll blew up");
    });
    const following = serialise(async () => "still works");

    await expect(failing).rejects.toThrow("poll blew up");
    expect(await following).toBe("still works");
    // And the queue is still usable afterwards.
    expect(await serialise(async () => "and again")).toBe("and again");
  });

  test("a task queued after everything settled still runs", async () => {
    const serialise = createSerialQueue();
    await serialise(async () => "first");
    await tick();
    expect(await serialise(async () => "later")).toBe("later");
  });
});
