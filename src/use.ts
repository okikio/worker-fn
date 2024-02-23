// deno-lint-ignore-file no-explicit-any

interface LazyWorker {
  /**
   * A function that returns a new Worker instance.
   */
  factory: () => Worker;
  /**
   * Time to live (in millisecond). Passing in `-1` will keep it alive forever.
   *
   * @default 0
   */
  ttl?: number;
}

/**
 * Invoke this function in the main thread to create a proxy function that calls the corresponding worker function.
 *
 * @param name - The name that identifies the worker function.
 * @param worker -
 * @param options - An object containing options.
 * @returns The proxy function.
 */
export function useWorkerFn<FN extends (...args: any[]) => any>(
  name: string,
  worker: Worker | LazyWorker,
  options: {
    /**
     * A function that determines the object to be transferred when posting messages to worker threads.
     *
     * @see https://developer.mozilla.org/en-US/docs/Web/API/Worker/postMessage#transfer
     * @param ctx The context of proxy function invocation.
     * @returns Transferable objects.
     */
    transfer?: (ctx: { args: Parameters<FN> }) => Transferable[];
  } = {},
): (...args: Parameters<FN>) => Promise<Awaited<ReturnType<FN>>> {
  // Options
  const { transfer } = options;

  // States
  let callCount = 0;
  let callingCount = 0;

  // Worker instance and its TTL
  let workerInst: Worker | undefined;
  let workerTtlTimeoutId: number | undefined;
  const ttl = worker instanceof Worker
    ? -1
    : worker.ttl === undefined
    ? 0
    : worker.ttl;

  // Proxy function
  function fn(...args: Parameters<FN>) {
    return new Promise<Awaited<ReturnType<FN>>>((resolve) => {
      // Update states
      callCount++;
      callingCount++;

      // Identify the current call
      const key = callCount;

      // Get the worker instance
      const _worker = workerInst = workerInst
        ? workerInst
        : worker instanceof Worker
        ? worker
        : worker.factory();

      // Stop the TTL timeout of the worker instance
      clearTimeout(workerTtlTimeoutId);

      // Event handler for messages from the worker thread
      const handler = (event: MessageEvent) => {
        // Destructure the message from worker thread
        const { key: receivedKey, ret } = event.data as {
          key: number;
          name: string;
          ret: Awaited<ReturnType<FN>>;
        };
        // Check if the message corresponds to the current call
        if (receivedKey !== key) {
          return;
        }
        // Remove the event listener and resolve the promise with the return value
        _worker.removeEventListener("message", handler);
        resolve(ret);
        // Update states
        callingCount--;
        // Set a TTL timeout for the worker instance
        if (callingCount === 0 && ttl >= 0 && ttl !== Infinity) {
          const terminate = () => {
            workerInst?.terminate();
            workerInst = undefined;
          };
          clearTimeout(workerTtlTimeoutId);
          workerTtlTimeoutId = ttl === 0
            ? (terminate(), undefined)
            : setTimeout(terminate, ttl);
        }
      };

      // Add the event listener for messages from the worker thread
      _worker.addEventListener("message", handler);

      // Post a message to the worker
      _worker.postMessage({
        key,
        name,
        args,
      }, {
        transfer: transfer?.({ args }),
      });
    });
  }

  // Return the proxy function
  return fn;
}
