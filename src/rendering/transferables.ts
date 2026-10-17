/**
 * Finds the ArrayBuffers reachable from a structured-clonable value, so large
 * worker payloads can be transferred instead of copied.
 */

/** Adds every non-shared ArrayBuffer reachable from `root` to `into`. */
export function collectArrayBuffers(
  root: unknown,
  into: Set<ArrayBuffer> = new Set(),
): Set<ArrayBuffer> {
  const visited = new WeakSet<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (value === null || typeof value !== "object") continue;
    if (visited.has(value)) continue;
    visited.add(value);
    if (ArrayBuffer.isView(value)) {
      if (value.buffer instanceof ArrayBuffer) into.add(value.buffer);
      continue;
    }
    if (value instanceof ArrayBuffer) {
      into.add(value);
      continue;
    }
    if (Array.isArray(value)) {
      // Numeric arrays hold no buffers; skip them without visiting each entry.
      if (value.length > 0 && typeof value[0] !== "object") continue;
      for (let index = 0; index < value.length; index++) stack.push(value[index]);
      continue;
    }
    if (value instanceof Map) {
      for (const [key, entry] of value) {
        stack.push(key);
        stack.push(entry);
      }
      continue;
    }
    if (value instanceof Set) {
      for (const entry of value) stack.push(entry);
      continue;
    }
    for (const key of Object.keys(value)) {
      stack.push((value as Record<string, unknown>)[key]);
    }
  }
  return into;
}

/**
 * The buffers of `payload` that can be transferred: reachable from the payload
 * but not from anything the sender keeps using (`retained`). Transferring a
 * retained buffer would detach it on the sending side.
 */
export function transferableBuffers(
  payload: unknown,
  retained: ReadonlySet<ArrayBuffer>,
): ArrayBuffer[] {
  const transfer: ArrayBuffer[] = [];
  for (const buffer of collectArrayBuffers(payload)) {
    if (buffer.byteLength > 0 && !retained.has(buffer)) transfer.push(buffer);
  }
  return transfer;
}
