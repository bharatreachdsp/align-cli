/**
 * The HTTP client for `/api/v1` (docs/25). Every call has a timeout, sends `X-Align-Client`, parses the
 * response with the shared schema, and turns failures into one of three typed errors. A response carrying
 * `X-Align-Upgrade: required` is noted (the caller prints the line once). Tokens go only in the
 * Authorization header and never into an error, a message or a log.
 */

import { gzipSync } from "node:zlib";
import { ErrorBody } from "@align/core/api";
import { CLIENT_HEADER, UPGRADE_HEADER, userAgent } from "@align/core/brand";
import type { z } from "zod";
import { VERSION } from "./version";

export const DEFAULT_TIMEOUT_MS = 10_000;

/** The server answered with an error body (or a non-JSON error). `code` is a docs/25 or RFC 8628 code. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** How long the server asked us to wait (`Retry-After`, or `details.retry_after_ms`), when it said. */
    readonly retryAfterMs: number | null = null,
    /** The error body's `details` (codes and numbers the server documents, e.g. ingest's `busy_kind`). */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** `Retry-After` in seconds (RFC 9110; the HTTP-date form is ignored), else the error body's `retry_after_ms`. */
function retryAfter(header: string | null, details: Record<string, unknown> | undefined): number | null {
  if (header && /^\d{1,6}$/.test(header.trim())) return Number(header.trim()) * 1000;
  const ms = details?.retry_after_ms;
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 3_600_000) : null;
}

/** The server could not be reached (DNS, refused, reset, TLS). */
export class NetworkError extends Error {
  override readonly name = "NetworkError";
}

/** No answer within the timeout. */
export class TimeoutError extends Error {
  override readonly name = "TimeoutError";
}

/** The answer did not match the contract (wrong server, or a version skew). */
export class ProtocolError extends Error {
  override readonly name = "ProtocolError";
}

export const isOffline = (e: unknown): boolean => e instanceof NetworkError || e instanceof TimeoutError;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Validates and normalises a server URL: `https:` anywhere, `http:` only on loopback (tokens never travel in
 * clear text). Returns the origin (and path, without a trailing slash), or null.
 */
export function normalizeServer(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type ApiOptions = {
  server: string;
  token?: string | null;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Called on every response that says this version is below `min_supported` (the caller prints once). */
  onUpgradeRequired?: () => void;
};

export type ApiResult<T> = { data: T; date: Date | null };

export class ApiClient {
  readonly server: string;

  constructor(private readonly opts: ApiOptions) {
    this.server = opts.server;
  }

  withToken(token: string | null): ApiClient {
    return new ApiClient({ ...this.opts, token });
  }

  async request<S extends z.ZodType>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    schema: S,
    body?: unknown,
    opts: { timeoutMs?: number; auth?: boolean; gzip?: boolean; gzipped?: Uint8Array; idempotencyKey?: string } = {},
  ): Promise<ApiResult<z.infer<S>>> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      [CLIENT_HEADER]: VERSION,
      "User-Agent": userAgent(VERSION),
    };
    if (body !== undefined || opts.gzipped) headers["Content-Type"] = "application/json";
    // docs/25: a retried mutation with the same key replays instead of acting twice.
    if (opts.idempotencyKey && /^[A-Za-z0-9_.:-]{8,128}$/.test(opts.idempotencyKey))
      headers["Idempotency-Key"] = opts.idempotencyKey;
    // `gzipped`: the JSON body already compressed by the caller (the uploader measures the 1 MB cap on it).
    let payload: string | Uint8Array | undefined =
      opts.gzipped ?? (body === undefined ? undefined : JSON.stringify(body));
    if (opts.gzip && !opts.gzipped && payload !== undefined) payload = gzipSync(payload);
    if (opts.gzipped || opts.gzip) headers["Content-Encoding"] = "gzip";
    if (opts.auth !== false && this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
    // AbortSignal.timeout takes whole milliseconds only (a fraction throws a RangeError).
    const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    const doFetch = this.opts.fetch ?? ((i: string, init: RequestInit) => fetch(i, init));
    let res: Response;
    try {
      res = await doFetch(`${this.server}/api/v1${path}`, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") throw new TimeoutError(`no answer in ${timeoutMs} ms`);
      throw new NetworkError("server unreachable");
    }
    if (res.headers.get(UPGRADE_HEADER) === "required") this.opts.onUpgradeRequired?.();
    const dateHeader = res.headers.get("date");
    const date = dateHeader ? new Date(dateHeader) : null;
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const parsed = ErrorBody.safeParse(json);
      const wait = retryAfter(res.headers.get("retry-after"), parsed.success ? parsed.data.error.details : undefined);
      if (parsed.success)
        throw new ApiError(
          res.status,
          parsed.data.error.code,
          parsed.data.error.message,
          wait,
          parsed.data.error.details,
        );
      throw new ApiError(res.status, res.status >= 500 ? "internal" : "invalid_response", `HTTP ${res.status}`, wait);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ProtocolError(`unexpected response from ${method} ${path.split("?")[0]}`);
    return { data: parsed.data, date: date && !Number.isNaN(date.getTime()) ? date : null };
  }
}
