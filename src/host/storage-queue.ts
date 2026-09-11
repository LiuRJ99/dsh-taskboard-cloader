/** One process-wide serial queue shared by all taskboard persistence. */
export class StorageQueue {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}
