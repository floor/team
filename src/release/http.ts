// The one network seam of `team release check`: a URL in, one HTTP attempt out. Every read the
// command makes is public and credential-free — this wiring sends no header of any kind, follows
// no redirect (a 3xx is the answer, and the checks read it as unknown), never reads a credential
// or a credential helper, and never touches git. The retry policy and the read/attempt caps live
// with the checks (src/release/checks.ts); here is only one attempt, with its timeout and its
// size limit.

/** One HTTP attempt: the status and the decoded, size-limited body, or why no response was read.
 *  Every kind that comes from a response carries its status — `http`, `too-large` (a body over
 *  the limit) and `undecodable` (a body that is not valid UTF-8, never repaired into a
 *  replacement character) — so the retry rule reads the status whatever the body; `timeout` and
 *  `transport` are the kinds with no response at all. */
export type Attempt =
  | { kind: 'http'; status: number; body: string }
  | { kind: 'timeout' }
  | { kind: 'transport' }
  | { kind: 'too-large'; status: number }
  | { kind: 'undecodable'; status: number };

export type Fetch = (url: string) => Promise<Attempt>;

/** Each attempt times out after this, the body read included. */
export const TIMEOUT_MS = 5000;

/** The response-body limit, measured after content decoding. */
export const BODY_LIMIT = 1024 * 1024;

function why(error: unknown): Attempt {
  return { kind: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'transport' };
}

/** Node's `fetch` as the command's network: HTTPS, no headers, no redirects followed. */
export const realFetch: Fetch = async (url) => {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    // The limit is on the decoded body: undici applies the content encoding as the body streams.
    const body = response.body;
    if (body === null) return { kind: 'http', status: response.status, body: '' };
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_LIMIT) {
        await reader.cancel();
        return { kind: 'too-large', status: response.status };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    // Fatal: a response that is not valid UTF-8 is not repaired into U+FFFD and read anyway.
    let bodyText: string;
    try {
      bodyText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { kind: 'undecodable', status: response.status };
    }
    return { kind: 'http', status: response.status, body: bodyText };
  } catch (error) {
    return why(error);
  }
};
