/**
 * A one-at-a-time queue.
 *
 * Polls arrive from three places - the scheduled tick, a freshly added link,
 * and the /poll command - and they must never overlap for the same feed. Two
 * concurrent polls would both read the snapshot before either wrote it, both
 * see the same booking as new, and both notify. Running every poll through one
 * queue makes that impossible without any per-feed locking.
 */
export type SerialQueue = <T>(task: () => Promise<T>) => Promise<T>;

export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();

  return <T>(task: () => Promise<T>): Promise<T> => {
    // Chained on both settlement paths, so one failing task doesn't wedge the
    // queue - and the caller still receives that task's own rejection.
    const result = tail.then(task, task);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
