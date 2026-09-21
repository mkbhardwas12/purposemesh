import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { seedStore, type RoleDraft } from "@cca/core";
import { authorizationFingerprintFor, buildApp } from "../src/app.js";
import { createApiControlState } from "../src/control-plane.js";
import { signAccessToken } from "../src/jwt.js";
import { openWarehouse } from "../src/warehouse.js";
import { RequestBudgets, requestRateLimits } from "../src/rate-limits.js";

const apps: FastifyInstance[] = [];
function createApp(options: Parameters<typeof buildApp>[1] = {}) {
  const store = seedStore();
  const app = buildApp(store, options);
  apps.push(app);
  return { app, store };
}
async function token(store: ReturnType<typeof seedStore>, principalId = "emma.acme") {
  const principal = store.principals.get(principalId)!;
  return signAccessToken({ sub: principalId, persona: principal.personaId, kind: principal.kind,
    capsules: store.liveCapsulesFor(principalId).map((capsule) => capsule.id),
    authorizationFingerprint: authorizationFingerprintFor(store, principalId) });
}
const auth = (value: string) => ({ authorization: `Bearer ${value}` });
const draft: RoleDraft = { name: "Scoped finance evaluation", verbs: ["view"], purpose: "finance",
  ceiling: "confidential", products: ["transactions"], tenants: ["ACME"], regions: ["NA"],
  departments: ["finance"], denyFields: ["account_number", "email"], sources: ["generic"] };

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("request budgets", () => {
  it("applies the maintained global limiter before authentication on every route", async () => {
    const { app } = createApp({ requestRateLimit: { ipMax: 2 } });
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/roles/palette" })).statusCode).toBe(401);
    const blocked = await app.inject({ method: "GET", url: "/api/warehouse/records?purpose=analytics" });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ code: "rate_limited" });
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("recovers after the global window expires without extending it on rejection", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const { app } = createApp({ requestRateLimit: { ipMax: 1, windowMs: 1000 } });
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(429);
    clock.mockReturnValue(now + 1001);
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
  });

  it("charges unknown paths against the same global budget", async () => {
    const { app } = createApp({ requestRateLimit: { ipMax: 1 } });
    expect((await app.inject({ method: "GET", url: "/unknown-one" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/unknown-two" })).statusCode).toBe(429);
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(429);
  });

  it.each([false, true])("ignores spoofed forwarding headers when trustProxy=%s", async (trustProxy) => {
    const { app } = createApp({ trustProxy, requestRateLimit: { ipMax: 1 } });
    const request = { method: "GET" as const, url: "/api/health", remoteAddress: "192.0.2.25" };
    expect((await app.inject({ ...request, headers: { "x-forwarded-for": "198.51.100.1" } })).statusCode).toBe(200);
    expect((await app.inject({ ...request, headers: { "x-forwarded-for": "198.51.100.2" } })).statusCode).toBe(429);
    expect((await app.inject({ ...request, remoteAddress: "192.0.2.26", headers: { "x-forwarded-for": "198.51.100.1" } })).statusCode).toBe(200);
  });

  it("normalizes IPv6 peers to a shared /64 budget", async () => {
    const { app } = createApp({ requestRateLimit: { ipMax: 1 } });
    expect((await app.inject({ method: "GET", url: "/api/health", remoteAddress: "2001:db8:1:2::1" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/health", remoteAddress: "2001:db8:1:2::abcd" })).statusCode).toBe(429);
  });

  it("rejects peer rotation at capacity without evicting live global budgets and then recovers", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const { app } = createApp({ requestRateLimit: { ipMax: 1, maxTrackedKeys: 1, windowMs: 1000 } });
    const request = (remoteAddress: string) => app.inject({ method: "GET", url: "/api/health", remoteAddress });
    expect((await request("192.0.2.1")).statusCode).toBe(200);
    expect((await request("192.0.2.1")).statusCode).toBe(429);
    for (const address of ["192.0.2.2", "192.0.2.3", "192.0.2.1"]) {
      const blocked = await request(address);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers["retry-after"]).toBe("1");
    }
    clock.mockReturnValue(now + 1001);
    expect((await request("192.0.2.2")).statusCode).toBe(200);
    expect((await request("192.0.2.1")).statusCode).toBe(429);
  });

  it("shares a principal budget across independently issued tokens but isolates other users", async () => {
    const { app, store } = createApp({ requestRateLimit: { principalMax: 2 } });
    const first = await token(store);
    const second = await token(store);
    expect(first).not.toBe(second);
    for (const [index, value] of [first, second].entries()) {
      expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: auth(value),
        remoteAddress: `192.0.2.${index + 1}` })).statusCode).toBe(200);
    }
    const blocked = await app.inject({ method: "GET", url: "/api/roles/palette", headers: auth(second) });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: auth(await token(store, "finn.globex")) })).statusCode).toBe(200);
  });

  it("does not allocate a principal budget using an unverified token", async () => {
    const { app, store } = createApp({ requestRateLimit: { principalMax: 1 } });
    const valid = await token(store);
    const [header, payload] = valid.split(".");
    const forged = `${header}.${payload}.${"a".repeat(43)}`;
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: auth(forged) })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: auth(valid) })).statusCode).toBe(200);
  });

  it("recovers the verified principal budget after its window without rotating tokens", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const { app, store } = createApp({ requestRateLimit: { principalMax: 1, windowMs: 1000 } });
    const headers = auth(await token(store));
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers })).statusCode).toBe(200);
    const blocked = await app.inject({ method: "GET", url: "/api/auth/me", headers });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("1");
    clock.mockReturnValue(now + 1001);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers })).statusCode).toBe(200);
  });

  it("blocks expensive reads before any query, audit append, or persistence write", async () => {
    const warehouse = openWarehouse({ path: ":memory:", rows: 50 });
    const persistence = { save: vi.fn(), check: vi.fn(), close: vi.fn() };
    const { app, store } = createApp({ warehouse, ownWarehouse: true, persistence,
      requestRateLimit: { expensiveReadMax: 1 } });
    const headers = auth(await token(store));
    const page = vi.spyOn(warehouse, "page");
    const query = vi.spyOn(warehouse, "query");
    expect((await app.inject({ method: "GET", url: "/api/warehouse/records?purpose=analytics", headers })).statusCode).toBe(200);
    const auditLength = store.audit.length;
    const writes = persistence.save.mock.calls.length;
    const blocked = await app.inject({ method: "GET", url: "/api/dashboard?purpose=analytics", headers });
    expect(blocked.statusCode).toBe(429);
    expect(page).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
    expect(store.audit).toHaveLength(auditLength);
    expect(persistence.save).toHaveBeenCalledTimes(writes);
  });

  it("blocks excess mutations before state, audit, or persistence changes", async () => {
    const state = createApiControlState();
    const persistence = { save: vi.fn(), check: vi.fn(), close: vi.fn() };
    const { app, store } = createApp({ state, persistence, requestRateLimit: { mutationMax: 1 } });
    const headers = auth(await token(store));
    const first = await app.inject({ method: "POST", url: "/api/role-requests", headers, payload: { draft } });
    expect(first.statusCode).toBe(200);
    const auditLength = store.audit.length;
    const writes = persistence.save.mock.calls.length;
    const blocked = await app.inject({ method: "POST", url: "/api/role-requests", headers,
      payload: { draft: { ...draft, name: "Different request name" } } });
    expect(blocked.statusCode).toBe(429);
    expect(state.roleRequests).toHaveLength(1);
    expect(store.audit).toHaveLength(auditLength);
    expect(persistence.save).toHaveBeenCalledTimes(writes);
  });

  it("limits successful login attempts across supplied usernames and forwarding headers", async () => {
    const persistence = { save: vi.fn(), check: vi.fn(), close: vi.fn() };
    const { app, store } = createApp({ persistence, trustProxy: true, requestRateLimit: { loginMax: 2 } });
    for (const username of ["emma.acme", "finn.globex"]) {
      expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "cca-demo" },
        headers: { "x-forwarded-for": username === "emma.acme" ? "198.51.100.1" : "198.51.100.2" } })).statusCode).toBe(200);
    }
    const auditLength = store.audit.length;
    const writes = persistence.save.mock.calls.length;
    const blocked = await app.inject({ method: "POST", url: "/api/auth/login",
      payload: { username: "hugo.admin", password: "cca-demo" }, headers: { "x-forwarded-for": "198.51.100.3" } });
    expect(blocked.statusCode).toBe(429);
    expect(store.audit).toHaveLength(auditLength);
    expect(persistence.save).toHaveBeenCalledTimes(writes);
  });

  it("charges malformed logins before validation and recovers after the login window", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const { app } = createApp({ requestRateLimit: { loginMax: 1, windowMs: 1000 } });
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: {} })).statusCode).toBe(400);
    const request = { method: "POST" as const, url: "/api/auth/login",
      payload: { username: "emma.acme", password: "cca-demo" } };
    const blocked = await app.inject(request);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("1");
    clock.mockReturnValue(now + 1001);
    expect((await app.inject(request)).statusCode).toBe(200);
  });

  it("shares the expensive budget across dashboard, preview, and policy evaluation", async () => {
    const { app, store } = createApp({ requestRateLimit: { expensiveReadMax: 1 } });
    const headers = auth(await token(store));
    expect((await app.inject({ method: "GET", url: "/api/dashboard?purpose=analytics", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/roles/preview", headers, payload: { draft } })).statusCode).toBe(429);
    expect((await app.inject({ method: "POST", url: "/api/pdp/check", headers,
      payload: { action: "view", datasetId: "bw_vendor", purpose: "vendor-performance" } })).statusCode).toBe(429);
  });

  it("preserves existing failed-login lockout inside the aggregate budget", async () => {
    const { app } = createApp({ trustProxy: true, loginRateLimit: { maxAttempts: 1 } });
    expect((await app.inject({ method: "POST", url: "/api/auth/login",
      headers: { "x-forwarded-for": "198.51.100.1" },
      payload: { username: "emma.acme", password: "incorrect" } })).statusCode).toBe(401);
    const blocked = await app.inject({ method: "POST", url: "/api/auth/login",
      headers: { "x-forwarded-for": "198.51.100.2" },
      payload: { username: "emma.acme", password: "cca-demo" } });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe("too many login attempts");
  });

  it("bounds subject and login tracking without evicting live limits", () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const budgets = new RequestBudgets(requestRateLimits({ maxTrackedKeys: 1, principalMax: 1, loginMax: 1, windowMs: 1000 }));
    budgets.consumePrincipal("one", "ordinary");
    expect(() => budgets.consumePrincipal("two", "ordinary")).toThrow(/too many requests/);
    expect(() => budgets.consumePrincipal("one", "ordinary")).toThrow(/too many requests/);
    budgets.consumeLogin("one");
    expect(() => budgets.consumeLogin("two")).toThrow(/too many requests/);
    clock.mockReturnValue(now + 1001);
    expect(() => budgets.consumePrincipal("two", "ordinary")).not.toThrow();
    expect(() => budgets.consumeLogin("two")).not.toThrow();
  });

  it.each([0, -1, 1.5, Infinity, NaN, 1_000_001])("rejects unsafe budget overrides: %s", (ipMax) => {
    expect(() => requestRateLimits({ ipMax })).toThrow(/rate-limit/);
  });
  it("rejects unknown options, disabling flags, and unsafe window/cache bounds", () => {
    expect(() => requestRateLimits({ enabled: false } as never)).toThrow(/recognized/);
    expect(() => requestRateLimits({ toString: 10 } as never)).toThrow(/recognized/);
    expect(() => requestRateLimits({ windowMs: 1 })).toThrow(/rate-limit/);
    expect(() => requestRateLimits({ maxTrackedKeys: 100_001 })).toThrow(/rate-limit/);
  });
});
