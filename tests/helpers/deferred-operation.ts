export interface DeferredOperationController<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
  isSettled(): boolean;
}

export function createDeferredOperation<T>(): DeferredOperationController<T> {
  let settled = false;
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve(value) {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
    reject(error) {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
    isSettled() {
      return settled;
    },
  };
}
