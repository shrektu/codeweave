export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = Promise.allSettled([result]);
    this.tails.set(key, tail);
    try {
      return await result;
    } finally {
      await tail;
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}
