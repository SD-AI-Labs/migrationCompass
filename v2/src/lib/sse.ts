/**
 * Reads SSE frames out of an accumulating buffer.
 *
 * Shared shape on both sides of the ask endpoint: the server writes
 * `data: {json}\n\n`, the browser reads it. Kept here rather than inline in the
 * component because chunk boundaries do not respect frame boundaries — a frame
 * arrives half-written about as often as not — and that is worth a test rather
 * than a manual retry when it misbehaves.
 */
export function drainSseEvents<T = unknown>(buffer: string): { events: T[]; rest: string } {
  const events: T[] = [];
  const parts = buffer.split("\n\n");
  // The final part is either an incomplete frame or empty; either way it stays
  // in the buffer until the rest of it arrives.
  const rest = parts.pop() ?? "";

  for (const part of parts) {
    for (const line of part.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload.length === 0 || payload === "[DONE]") continue;
      try {
        events.push(JSON.parse(payload) as T);
      } catch {
        // A frame that cannot be parsed is dropped rather than throwing away the
        // whole response — the remaining frames still form a usable answer.
        continue;
      }
    }
  }

  return { events, rest };
}
