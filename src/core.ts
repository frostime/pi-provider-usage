import { createHmac } from "node:crypto";
export function fingerprintResolvedAuth(
  auth: {
    apiKey?: string;
    headers?: Record<string, string | null>;
    baseUrl?: string;
    env?: Record<string, string>;
    source?: string;
    providerAuth?: {
      apiKey?: string;
      headers?: Record<string, string | null>;
      baseUrl?: string;
    };
  },
  salt: Uint8Array,
): string {
  const headers = Object.entries(auth.headers ?? {})
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const env = Object.entries(auth.env ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const providerHeaders = Object.entries(auth.providerAuth?.headers ?? {})
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const canonical = JSON.stringify({
    apiKey: auth.apiKey ?? "",
    headers,
    baseUrl: auth.baseUrl ?? "",
    env,
    source: auth.source ?? "",
    providerAuth: {
      apiKey: auth.providerAuth?.apiKey ?? "",
      headers: providerHeaders,
      baseUrl: auth.providerAuth?.baseUrl ?? "",
    },
  });
  return createHmac("sha256", salt).update(canonical).digest("hex");
}

export async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  signal: AbortSignal,
): Promise<PromiseSettledResult<R>[]> {
  if (signal.aborted) throw abortError();
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Concurrency limit must be positive.");

  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      if (signal.aborted) throw abortError();
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = {
          status: "fulfilled",
          value: await worker(items[index] as T, index, signal),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });

  await Promise.all(runners);
  if (signal.aborted) throw abortError();
  return results;
}

export async function awaitWithDeadline<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  description: string,
): Promise<T> {
  if (signal.aborted) throw abortError();
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  signal.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => {
            reject(
              signal.aborted
                ? abortError()
                : Object.assign(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s ${description}.`), {
                    name: "TimeoutError",
                  }),
            );
          },
          { once: true },
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abortFromCaller);
  }
}

export function sanitizeDisplayText(value: string, maxChars = 160): string {
  let result = "";
  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index) ?? 0;
    const character = String.fromCodePoint(codePoint);
    if (codePoint === 0x1b || codePoint === 0x9b || codePoint === 0x9d) {
      index = skipTerminalEscape(value, index, codePoint);
      continue;
    }
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) result += " ";
      index += character.length;
      continue;
    }
    result += character;
    index += character.length;
  }
  return truncate(result.replace(/\s+/gu, " ").trim(), maxChars);
}

export function redactUsageError(value: string, secrets: readonly string[] = []): string {
  let redacted = value;
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    redacted = redacted.replace(new RegExp(escapeRegExp(secret), "g"), "<redacted>");
  }
  redacted = redacted
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/"(?:access_token|refresh_token|api_key)"\s*:\s*"[^"]+"/gi, (match) => {
      const separator = match.indexOf(":");
      return `${match.slice(0, separator + 1)}"<redacted>"`;
    });
  return sanitizeDisplayText(redacted, 600);
}

export function errorMessage(error: unknown): string {
  return sanitizeDisplayText(error instanceof Error ? error.message : String(error), 600);
}

export function abortError(): Error {
  return Object.assign(new Error("Usage query aborted."), { name: "AbortError" });
}

function skipTerminalEscape(value: string, start: number, codePoint: number): number {
  let index = start + 1;
  const next = value.charCodeAt(index);
  const isOsc = codePoint === 0x9d || (codePoint === 0x1b && next === 0x5d);
  if (isOsc) {
    if (codePoint === 0x1b) index += 1;
    while (index < value.length) {
      const current = value.charCodeAt(index);
      if (current === 0x07) return index + 1;
      if (current === 0x1b && value.charCodeAt(index + 1) === 0x5c) return index + 2;
      index += 1;
    }
    return index;
  }
  const isCsi = codePoint === 0x9b || (codePoint === 0x1b && next === 0x5b);
  if (isCsi) {
    if (codePoint === 0x1b) index += 1;
    while (index < value.length) {
      const current = value.charCodeAt(index);
      index += 1;
      if (current >= 0x40 && current <= 0x7e) break;
    }
    return index;
  }
  return Math.min(value.length, start + (codePoint === 0x1b ? 2 : 1));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}
