// Concurrent callers share the same operation, including its failure.
export function singleFlight() {
  const pending = new Map();
  return (key, run) => {
    if (pending.has(key)) return pending.get(key);
    const task = Promise.resolve().then(run).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  };
}
