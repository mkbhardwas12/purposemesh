import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { seedStore, type RoleDraft } from "@cca/core";
import { authorizationFingerprintFor, buildApp } from "../src/app.js";
import { signAccessToken } from "../src/jwt.js";

const apps: FastifyInstance[] = [];

function createApp(options: Parameters<typeof buildApp>[1] = {}) {
  const app = buildApp(seedStore(), options);
  apps.push(app);
  return app;
}

async function login(app: FastifyInstance, username: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password: "cca-demo" },
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { token: string }).token;
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

const financeDraft: RoleDraft = {
  name: "ACME NA finance analyst",
  verbs: ["view"],
  purpose: "finance",
  ceiling: "confidential",
  products: ["transactions"],
  tenants: ["ACME"],
  regions: ["NA"],
  departments: ["finance"],
  denyFields: ["account_number", "email"],
  sources: ["generic"],
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("frontend-to-backend workflows", () => {
  it("completes self-service request, independent review, role application, compile, and audit", async () => {
    const app = createApp();
    const userToken = await login(app, "emma.acme");
    const adminToken = await login(app, "hugo.admin");
    const ownerToken = await login(app, "dana.owner");

    const initialCatalog = await app.inject({
      method: "GET",
      url: "/api/catalog",
      headers: auth(userToken),
    });
    expect(initialCatalog.statusCode).toBe(200);
    expect(initialCatalog.json()).toMatchObject({ features: { demoReset: false } });

    const initialDashboard = await app.inject({
      method: "GET",
      url: "/api/dashboard?purpose=analytics",
      headers: auth(userToken),
    });
    expect(initialDashboard.statusCode).toBe(200);
    expect(initialDashboard.json().visible).toBeGreaterThan(0);

    const unsupportedGeneratedDraft = await app.inject({
      method: "POST",
      url: "/api/roles/from-ask",
      headers: auth(adminToken),
      payload: { ask: "Rotate credentials for the finance team" },
    });
    expect(unsupportedGeneratedDraft.statusCode).toBe(200);
    expect(unsupportedGeneratedDraft.json().errors).toEqual(expect.arrayContaining([
      "unknown verb",
      "drop at least one data product",
    ]));

    const preview = await app.inject({
      method: "POST",
      url: "/api/roles/preview",
      headers: auth(userToken),
      payload: { draft: financeDraft },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ sample: [], previewMode: "metadata", constrainedToActor: true, errors: [] });

    const created = await app.inject({
      method: "POST",
      url: "/api/role-requests",
      headers: auth(userToken),
      payload: { draft: financeDraft },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      requesterId: "emma.acme",
      principalId: "emma.acme",
      status: "pending",
      draft: financeDraft,
    });

    const queue = await app.inject({
      method: "GET",
      url: "/api/role-requests",
      headers: auth(adminToken),
    });
    expect(queue.statusCode).toBe(200);
    expect(queue.json().requests).toEqual([
      expect.objectContaining({ id: created.json().id, status: "pending" }),
    ]);

    const adminApproved = await app.inject({
      method: "POST",
      url: `/api/role-requests/${created.json().id}/approve`,
      headers: auth(adminToken),
    });
    expect(adminApproved.statusCode).toBe(200);
    expect(adminApproved.json()).toMatchObject({
      status: "pending",
      approvals: [expect.objectContaining({ reviewerId: "hugo.admin", reviewerRole: "governance-admin" })],
    });
    const approved = await app.inject({
      method: "POST",
      url: `/api/role-requests/${created.json().id}/approve`,
      headers: auth(ownerToken),
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      status: "approved",
      reviewerId: "dana.owner",
      approvals: [
        expect.objectContaining({ reviewerRole: "governance-admin" }),
        expect.objectContaining({ reviewerRole: "data-owner" }),
      ],
    });
    const applied = approved.json().applied as { personaId: string; capsuleId: string; contractId: string };

    const staleSession = await app.inject({ method: "GET", url: "/api/auth/me", headers: auth(userToken) });
    expect(staleSession.statusCode).toBe(401);
    expect(staleSession.json().code).toBe("session_stale");

    const refreshedToken = await login(app, "emma.acme");
    const financeDashboard = await app.inject({
      method: "GET",
      url: "/api/dashboard?purpose=finance",
      headers: auth(refreshedToken),
    });
    expect(financeDashboard.statusCode).toBe(200);
    expect(financeDashboard.json().visible).toBeGreaterThan(0);
    expect(financeDashboard.json().sample.every((row: Record<string, unknown>) =>
      row.product === "transactions"
      && row.tenant === "ACME"
      && row.region === "NA"
      && row.department === "finance"
      && !("account_number" in row)
      && !("email" in row)
    )).toBe(true);

    const compiled = await app.inject({
      method: "GET",
      url: `/api/compiler/${applied.capsuleId}`,
      headers: auth(adminToken),
    });
    expect(compiled.statusCode).toBe(200);
    expect(compiled.json()).toMatchObject({ capsuleId: applied.capsuleId });
    expect(compiled.json()).toHaveProperty("elasticsearch");
    expect(compiled.json()).toHaveProperty("bw");

    const evidence = await app.inject({ method: "GET", url: "/api/audit", headers: auth(adminToken) });
    expect(evidence.statusCode).toBe(200);
    const events = evidence.json().events as Array<{ type: string; detail: Record<string, unknown> }>;
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "role.request",
      "role.apply",
      "role.request.approve",
      "warehouse.dashboard",
    ]));
    expect(events.find((event) => event.type === "role.request.approve")?.detail).toMatchObject({
      id: created.json().id,
      principalId: "emma.acme",
    });
  });

  it("completes JIT dual control, protected data release, and capsule revocation", async () => {
    const app = createApp();
    const operatorToken = await login(app, "ben.l2bw");
    const adminToken = await login(app, "hugo.admin");

    const before = await app.inject({
      method: "GET",
      url: "/api/data/bw_vendor?purpose=replication-repair",
      headers: auth(operatorToken),
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().records).toEqual([]);

    const requested = await app.inject({
      method: "POST",
      url: "/api/jit",
      headers: auth(operatorToken),
      payload: {
        datasetId: "bw_vendor",
        capsuleId: "support-l2-bw",
        purpose: "replication-repair",
        actions: ["view"],
        justification: "Investigate failed vendor replication",
        durationMs: 900_000,
      },
    });
    expect(requested.statusCode).toBe(200);
    expect(requested.json()).toMatchObject({
      status: "pending",
      purpose: "replication-repair",
      requestedTtlMs: 900_000,
    });

    const approvalQueue = await app.inject({ method: "GET", url: "/api/jit", headers: auth(adminToken) });
    expect(approvalQueue.statusCode).toBe(200);
    expect(approvalQueue.json().grants).toEqual([
      expect.objectContaining({
        id: requested.json().id,
        justification: "Investigate failed vendor replication",
        requestedTtlMs: 900_000,
      }),
    ]);

    const approved = await app.inject({
      method: "POST",
      url: `/api/jit/${requested.json().id}/approve`,
      headers: auth(adminToken),
      payload: { ttlMs: 900_000 },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: "approved", approverId: "hugo.admin" });

    const elevated = await app.inject({
      method: "GET",
      url: "/api/data/bw_vendor?purpose=replication-repair",
      headers: auth(operatorToken),
    });
    expect(elevated.statusCode).toBe(200);
    expect(elevated.json().decision.reason).toBe("jit_allow");
    expect(elevated.json().records.map((row: { attrs: { vendor_id: string } }) => row.attrs.vendor_id))
      .toEqual(["V1001", "V1002"]);
    expect(elevated.json().records.every((row: { attrs: Record<string, unknown> }) =>
      !("spend" in row.attrs)
    )).toBe(true);

    const offboarded = await app.inject({
      method: "POST",
      url: "/api/capsules/support-l2-bw/offboard",
      headers: auth(adminToken),
      payload: { cascade: false },
    });
    expect(offboarded.statusCode).toBe(200);
    expect(offboarded.json().expiredJit).toContain(requested.json().id);
    expect(offboarded.json().removedMembers).toContain("ben.l2bw");

    const revoked = await app.inject({
      method: "GET",
      url: "/api/data/bw_vendor?purpose=replication-repair",
      headers: auth(operatorToken),
    });
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json().code).toBe("session_stale");
    const refreshedOperator = await login(app, "ben.l2bw");
    const denied = await app.inject({
      method: "GET",
      url: "/api/data/bw_vendor?purpose=replication-repair",
      headers: auth(refreshedOperator),
    });
    expect(denied.json().records).toEqual([]);

    const catalog = await app.inject({ method: "GET", url: "/api/catalog", headers: auth(adminToken) });
    expect(catalog.json().capsules).toContainEqual(expect.objectContaining({ id: "support-l2-bw", active: false }));
  });

  it("advertises demo reset only when the matching backend route is available", async () => {
    const demoApp = createApp();
    const demoAdmin = await login(demoApp, "hugo.admin");
    const demoCatalog = await demoApp.inject({ method: "GET", url: "/api/catalog", headers: auth(demoAdmin) });
    expect(demoCatalog.json()).toMatchObject({ features: { demoReset: true } });

    const productionApp = createApp({ demoMode: false });
    const productionToken = await signAccessToken({
      sub: "hugo.admin",
      persona: "admin",
      capsules: ["control-plane"],
      authorizationFingerprint: authorizationFingerprintFor(seedStore(), "hugo.admin"),
      kind: "human",
      purpose: "governance",
    });
    const productionCatalog = await productionApp.inject({
      method: "GET",
      url: "/api/catalog",
      headers: auth(productionToken),
    });
    expect(productionCatalog.statusCode).toBe(200);
    expect(productionCatalog.json()).toMatchObject({ features: { demoReset: false } });

    const reset = await productionApp.inject({
      method: "POST",
      url: "/api/store/reset",
      headers: auth(productionToken),
    });
    expect(reset.statusCode).toBe(404);
  });
});
