/**
 * Deterministic waiting for tests: poll a condition at a small step until it
 * holds, or fail with a clear error once the deadline passes. Replaces fixed
 * `setTimeout` sleeps that guessed at fsync/rename latency (Windows: atomic
 * persists can exceed 10ms now and then) — the wait ends the moment the
 * target ledger/DOM state actually appears.
 *
 * The condition may be sync or async:
 * - returning `false` (or a promise resolving to `false`) → not ready yet;
 * - returning anything else / `void` → satisfied;
 * - throwing → treated as "not ready yet" and retried; the LAST error is
 *   re-thrown on timeout so a genuinely broken condition stays diagnosable.
 *
 * @module dsh-taskboard/tests/wait-for
 */

/** Poll step: small enough to converge fast, big enough not to spin the CPU. */
const STEP_MS = 15

/**
 * Wait until `cond` is satisfied.
 * @param cond - the condition to poll.
 * @param timeoutMs - deadline in milliseconds (default 5s; keep >= 2s —
 *        Windows fsync+rename on a slow CI box can occasionally take that long).
 * @throws Error when the condition never holds within `timeoutMs`.
 */
export async function waitFor(
  cond: () => boolean | void | Promise<unknown>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  for (;;) {
    let satisfied: boolean
    try {
      const value = await cond()
      satisfied = value !== false
    } catch (error) {
      satisfied = false
      lastError = error
    }
    if (satisfied) return
    if (Date.now() >= deadline) {
      if (lastError !== undefined) {
        throw new Error(`waitFor: condition not met within ${timeoutMs}ms (last error: ${String(lastError)})`)
      }
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`)
    }
    await new Promise(resolve => setTimeout(resolve, STEP_MS))
  }
}
