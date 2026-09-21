import type { FastifyRequest } from "fastify";
import { normalizeIP, type FastifyRateLimitStore, type FastifyRateLimitStoreCtor } from "@fastify/rate-limit";

export type RequestRateLimits = {
  windowMs: number;
  ipMax: number;
  principalMax: number;
  expensiveReadMax: number;
  mutationMax: number;
  loginMax: number;
  maxTrackedKeys: number;
};

/** Process-local budgets for the single-node reference service. */
export const DEFAULT_REQUEST_RATE_LIMITS: Readonly<RequestRateLimits> = Object.freeze({
  windowMs: 60_000,
  ipMax: 600,
  principalMax: 600,
  expensiveReadMax: 300,
  mutationMax: 30,
  loginMax: 20,
  maxTrackedKeys: 10_000,
});

export function requestRateLimits(overrides: Partial<RequestRateLimits> = {}): RequestRateLimits {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)
    || Object.keys(overrides).some((key) => !Object.hasOwn(DEFAULT_REQUEST_RATE_LIMITS, key))) {
    throw new Error("request rate-limit options must use recognized budget names");
  }
  const limits = { ...DEFAULT_REQUEST_RATE_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    const minimum = key === "windowMs" ? 100 : 1;
    const maximum = key === "windowMs" ? 3_600_000 : key === "maxTrackedKeys" ? 100_000 : 1_000_000;
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`request rate-limit ${key} must be an integer between ${minimum} and ${maximum}`);
    }
  }
  return limits;
}

export class RequestRateLimitError extends Error {
  readonly statusCode = 429;
  readonly code = "rate_limited";
  constructor(readonly retryAfterSeconds: number) {
    super("too many requests; retry after the indicated delay");
  }
}

/** Never key protection on caller-supplied forwarding headers, even with trustProxy enabled. */
export function transportPeer(request: FastifyRequest): string {
  const address = request.raw.socket.remoteAddress;
  return address ? normalizeIP(address, 64) : "unknown-transport-peer";
}

/** The plugin's default LRU evicts live peers; reject new keys at capacity instead. */
export function boundedPeerStore(maxTrackedKeys: number): FastifyRateLimitStoreCtor {
  type PeerCounter = { current: number; expiresAt: number };
  type Callback = Parameters<FastifyRateLimitStore["incr"]>[1];
  return class BoundedPeerStore implements FastifyRateLimitStore {
    private readonly peers = new Map<string, PeerCounter>();

    incr(key: string, callback: Callback, timeWindow: number, max: number): void {
      const now = Date.now();
      const current = this.peers.get(key);
      if (current && current.expiresAt > now) {
        // No extended lockout or unbounded count growth on repeated rejection.
        current.current = Math.min(current.current + 1, max + 1);
        callback(null, { current: current.current, ttl: current.expiresAt - now });
        return;
      }
      if (current) this.peers.delete(key);
      if (this.peers.size >= maxTrackedKeys) {
        let earliest = Infinity;
        for (const [storedKey, value] of this.peers) {
          if (value.expiresAt <= now) this.peers.delete(storedKey);
          else earliest = Math.min(earliest, value.expiresAt);
        }
        if (this.peers.size >= maxTrackedKeys) {
          // Return an exceeded result through the maintained plugin so headers
          // and error handling match normal rate limits, without inserting a key.
          callback(null, { current: max + 1, ttl: earliest - now });
          return;
        }
      }
      this.peers.set(key, { current: 1, expiresAt: now + timeWindow });
      callback(null, { current: 1, ttl: timeWindow });
    }

    child(): FastifyRateLimitStore {
      return new BoundedPeerStore();
    }
  };
}

type Counter = { expiresAt: number; total: number; expensive: number; mutations: number };
type RequestCost = "ordinary" | "expensive" | "mutation";

export function requestCost(request: Pick<FastifyRequest, "method" | "routeOptions">): RequestCost {
  const route = request.routeOptions.url ?? "";
  // Evaluation and preview POSTs are read-like, but still spend the query budget.
  if (["/api/roles/from-ask", "/api/roles/preview", "/api/pdp/check", "/access/v1/evaluation"].includes(route)) {
    return "expensive";
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) return "mutation";
  if (["/api/dashboard", "/api/warehouse/records", "/api/pdp/explain", "/api/governance/sod/violations", "/api/audit"].includes(route)
    || route.startsWith("/api/compiler") || route.startsWith("/api/data/") || route.startsWith("/api/recertifications")) {
    return "expensive";
  }
  return "ordinary";
}

/** Only verified principal IDs enter the subject map; login uses the transport peer. */
export class RequestBudgets {
  private readonly principals = new Map<string, Counter>();
  private readonly logins = new Map<string, Counter>();
  constructor(private readonly limits: RequestRateLimits) {}

  consumePrincipal(principalId: string, cost: RequestCost): void {
    const now = Date.now();
    const counter = this.counter(this.principals, principalId, now);
    if (counter.total >= this.limits.principalMax
      || cost === "expensive" && counter.expensive >= this.limits.expensiveReadMax
      || cost === "mutation" && counter.mutations >= this.limits.mutationMax) {
      throw this.blocked(counter.expiresAt, now);
    }
    counter.total++;
    if (cost === "expensive") counter.expensive++;
    if (cost === "mutation") counter.mutations++;
  }

  consumeLogin(peer: string): void {
    const now = Date.now();
    const counter = this.counter(this.logins, peer, now);
    if (counter.total >= this.limits.loginMax) throw this.blocked(counter.expiresAt, now);
    counter.total++;
  }

  private blocked(expiresAt: number, now: number): RequestRateLimitError {
    return new RequestRateLimitError(Math.max(1, Math.ceil((expiresAt - now) / 1000)));
  }

  private counter(counters: Map<string, Counter>, key: string, now: number): Counter {
    const current = counters.get(key);
    if (current && current.expiresAt > now) return current;
    if (current) counters.delete(key);
    if (counters.size >= this.limits.maxTrackedKeys) {
      let earliest = Infinity;
      for (const [storedKey, value] of counters) {
        if (value.expiresAt <= now) counters.delete(storedKey);
        else earliest = Math.min(earliest, value.expiresAt);
      }
      // Do not evict live budgets: rotating keys must not reset an existing limit.
      if (counters.size >= this.limits.maxTrackedKeys) throw this.blocked(earliest, now);
    }
    const created = { expiresAt: now + this.limits.windowMs, total: 0, expensive: 0, mutations: 0 };
    counters.set(key, created);
    return created;
  }
}
