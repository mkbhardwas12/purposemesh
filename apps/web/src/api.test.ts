import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, getToken, setToken, UNAUTHORIZED_EVENT } from "./api";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function pendingBody(status = 200) {
  const body = deferred<unknown>();
  const reading = deferred<void>();
  let signal!: AbortSignal;
  const fetch = vi.fn(async (_path: string, init: RequestInit) => {
    signal = init.signal!;
    signal.addEventListener("abort", () => {
      body.reject(new DOMException("The operation was aborted", "AbortError"));
    }, { once: true });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => { reading.resolve(); return body.promise; },
    };
  });
  vi.stubGlobal("fetch", fetch);
  return { body, reading: reading.promise, fetch, signal: () => signal };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("API request lifetime", () => {
  it("does not send a request whose caller has already cancelled it", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const caller = new AbortController();
    caller.abort();

    await expect(api.me(caller.signal)).rejects.toMatchObject({ message: "Request cancelled", status: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a request while its response body is still arriving", async () => {
    const response = pendingBody();
    const caller = new AbortController();
    const request = api.me(caller.signal);
    const rejection = expect(request).rejects.toMatchObject({ message: "Request cancelled", status: 0 });
    await response.reading;

    caller.abort();

    expect(response.signal().aborted).toBe(true);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a request whose headers arrive but body stalls", async () => {
    const response = pendingBody();
    const request = api.me();
    const rejection = expect(request).rejects.toMatchObject({ message: "Request timed out", status: 0 });
    await response.reading;

    await vi.advanceTimersByTimeAsync(20_000);

    expect(response.signal().aborted).toBe(true);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases cancellation resources after reading a successful body", async () => {
    const response = pendingBody();
    const caller = new AbortController();
    const request = api.me(caller.signal);
    await response.reading;
    response.body.resolve({ id: "emma.acme" });

    await expect(request).resolves.toEqual({ id: "emma.acme" });
    expect(vi.getTimerCount()).toBe(0);
    caller.abort();
    expect(response.signal().aborted).toBe(false);
  });

  it("preserves HTTP errors when the response body is not JSON", async () => {
    const response = pendingBody(502);
    const request = api.me();
    const rejection = expect(request).rejects.toMatchObject({ message: "Request failed (HTTP 502)", status: 502 });
    await response.reading;
    response.body.reject(new SyntaxError("Unexpected token"));

    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("session expiration", () => {
  it("does not expire a newer session when an old request returns 401", async () => {
    setToken("old-session");
    const response = pendingBody(401);
    const dispatch = vi.spyOn(window, "dispatchEvent");
    const request = api.me();
    const rejection = expect(request).rejects.toMatchObject({ message: "Expired session", status: 401 });
    await response.reading;

    setToken("new-session");
    response.body.resolve({ error: "Expired session" });

    await rejection;
    expect(dispatch).not.toHaveBeenCalled();
    expect(getToken()).toBe("new-session");
  });

  it("still expires the current session on a 401 and preserves API error details", async () => {
    setToken("current-session");
    const response = pendingBody(401);
    const dispatch = vi.spyOn(window, "dispatchEvent");
    const request = api.me();
    const rejection = expect(request).rejects.toMatchObject({
      message: "Expired session", status: 401, code: "expired", details: { retry: true },
    });
    await response.reading;
    response.body.resolve({ error: "Expired session", code: "expired", details: { retry: true } });

    await rejection;
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]![0].type).toBe(UNAUTHORIZED_EVENT);
  });
});
