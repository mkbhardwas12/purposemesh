import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { applyRoleDraft, removeMembership, seedStore, type RoleDraft } from "@cca/core";
import { authorizationFingerprintFor, buildApp } from "../src/app.js";
import {
  createApiControlState,
  SqliteControlPlaneRepository,
  type ControlPlanePersistence,
} from "../src/control-plane.js";
import { assertJwtConfiguration, signAccessToken } from "../src/jwt.js";

const apps: FastifyInstance[] = [];

function createApp(store = seedStore(), options: Parameters<typeof buildApp>[1] = {}) {
  const app = buildApp(store, options);
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

function roleDraft(overrides: Partial<RoleDraft> = {}): RoleDraft {
  return {
    name: "ACME finance reviewer",
    verbs: ["view"],
    purpose: "finance",
    ceiling: "confidential",
    products: ["transactions"],
    tenants: ["ACME"],
    regions: ["NA"],
    departments: ["finance"],
    denyFields: ["account_number", "email"],
    sources: ["generic"],
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("API hardening", () => {
  it("validates request bodies and requires a purpose for data reads", async () => {
    const app = createApp();
    const malformed = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "emma.acme", password: "cca-demo", unexpected: true },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().code).toBe("validation_error");

    const invalidJson = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" },
      payload: "{",
    });
    expect(invalidJson.statusCode).toBe(400);
    expect(invalidJson.json().code).toBe("bad_request");

    const token = await login(app, "emma.acme");
    const missingPurpose = await app.inject({
      method: "GET",
      url: "/api/data/bw_vendor",
      headers: auth(token),
    });
    expect(missingPurpose.statusCode).toBe(400);
    expect(missingPurpose.json().code).toBe("validation_error");
  });

  it("revalidates disabled principals and persona changes on every call", async () => {
    const store = seedStore();
    const app = createApp(store);
    const disabledToken = await login(app, "emma.acme");
    store.principals.get("emma.acme")!.disabled = true;
    const disabled = await app.inject({ method: "GET", url: "/api/auth/me", headers: auth(disabledToken) });
    expect(disabled.statusCode).toBe(401);
    expect(disabled.json().code).toBe("principal_inactive");

    store.principals.get("emma.acme")!.disabled = false;
    const staleToken = await login(app, "emma.acme");
    store.principals.get("emma.acme")!.personaId = "l1";
    const stale = await app.inject({ method: "GET", url: "/api/auth/me", headers: auth(staleToken) });
    expect(stale.statusCode).toBe(401);
    expect(stale.json().code).toBe("session_stale");
  });

  it("does not resurrect a token when the same capsule is re-granted as a new assignment", async () => {
    const store = seedStore();
    const app = createApp(store);
    const oldToken = await login(app, "emma.acme");
    const original = store.memberships.find((membership) =>
      membership.principalId === "emma.acme" && membership.capsuleId === "vendor-acme"
    )!;

    removeMembership(store, "hugo.admin", "emma.acme", "vendor-acme");
    const revoked = await app.inject({ method: "GET", url: "/api/auth/me", headers: auth(oldToken) });
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json().code).toBe("session_stale");

    store.memberships.push({
      ...original,
      assignmentId: "assignment.approved-regrant-regression",
    });
    const resurrected = await app.inject({ method: "GET", url: "/api/auth/me", headers: auth(oldToken) });
    expect(resurrected.statusCode).toBe(401);
    expect(resurrected.json().code).toBe("session_stale");

    const freshToken = await login(app, "emma.acme");
    const freshAccess = await app.inject({
      method: "GET",
      url: "/api/warehouse/records?purpose=analytics&limit=100",
      headers: auth(freshToken),
    });
    expect(freshAccess.statusCode).toBe(200);
    expect(freshAccess.json().visible).toBeGreaterThan(0);
    expect(freshAccess.json().records.every((row: { tenant: string }) => row.tenant === "ACME"))
      .toBe(true);
  });

  it("rejects direct business membership grants and preserves tenant isolation", async () => {
    const store = seedStore();
    const app = createApp(store);
    const admin = await login(app, "hugo.admin");
    const finn = await login(app, "finn.globex");

    const bypass = await app.inject({
      method: "POST",
      url: "/api/capsules/vendor-acme/members",
      headers: auth(admin),
      payload: { principalId: "finn.globex" },
    });
    expect(bypass.statusCode).toBe(409);
    expect(bypass.json()).toMatchObject({
      code: "approval_workflow_required",
      error: "business and data memberships require an approved role request",
    });
    expect(store.memberships).not.toContainEqual(expect.objectContaining({
      principalId: "finn.globex",
      capsuleId: "vendor-acme",
    }));

    const data = await app.inject({
      method: "GET",
      url: "/api/warehouse/records?purpose=analytics&limit=100",
      headers: auth(finn),
    });
    expect(data.statusCode).toBe(200);
    expect(data.json().visible).toBeGreaterThan(0);
    expect(data.json().records.every((row: { tenant: string }) => row.tenant === "GLOBEX"))
      .toBe(true);
  });

  it("uses an administrator-reviewed role request workflow", async () => {
    const app = createApp();
    const emma = await login(app, "emma.acme");
    const finn = await login(app, "finn.globex");
    const admin = await login(app, "hugo.admin");
    const owner = await login(app, "dana.owner");

    const direct = await app.inject({
      method: "POST",
      url: "/api/roles/apply",
      headers: auth(emma),
      payload: { draft: roleDraft(), principalId: "emma.acme" },
    });
    expect(direct.statusCode).toBe(403);

    const created = await app.inject({
      method: "POST",
      url: "/api/role-requests",
      headers: auth(emma),
      payload: { draft: roleDraft() },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ requesterId: "emma.acme", principalId: "emma.acme", status: "pending" });

    const otherUser = await app.inject({ method: "GET", url: "/api/role-requests", headers: auth(finn) });
    expect(otherUser.json().requests).toEqual([]);

    const adminApproved = await app.inject({
      method: "POST",
      url: `/api/role-requests/${created.json().id}/approve`,
      headers: auth(admin),
    });
    expect(adminApproved.statusCode).toBe(200);
    expect(adminApproved.json().status).toBe("pending");
    const approved = await app.inject({
      method: "POST",
      url: `/api/role-requests/${created.json().id}/approve`,
      headers: auth(owner),
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe("approved");
    expect(approved.json().applied.personaId).toMatch(/^capability\./);

    const stale = await app.inject({ method: "GET", url: "/api/auth/me", headers: auth(emma) });
    expect(stale.statusCode).toBe(401);
    const refreshed = await login(app, "emma.acme");
    const dashboard = await app.inject({
      method: "GET",
      url: "/api/dashboard?purpose=finance",
      headers: auth(refreshed),
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().visible).toBeGreaterThan(0);
  });

  it("supports denying a pending request and prevents a second decision", async () => {
    const app = createApp();
    const emma = await login(app, "emma.acme");
    const admin = await login(app, "hugo.admin");
    const created = await app.inject({
      method: "POST",
      url: "/api/role-requests",
      headers: auth(emma),
      payload: { draft: roleDraft({ name: "Temporary finance request" }) },
    });
    const denied = await app.inject({
      method: "POST",
      url: `/api/role-requests/${created.json().id}/deny`,
      headers: auth(admin),
      payload: { reason: "Scope needs an owner review" },
    });
    expect(denied.statusCode).toBe(200);
    expect(denied.json()).toMatchObject({ status: "denied", reason: "Scope needs an owner review" });

    const repeated = await app.inject({
      method: "POST",
      url: `/api/role-requests/${created.json().id}/approve`,
      headers: auth(admin),
    });
    expect(repeated.statusCode).toBe(409);
  });

  it("constrains ordinary previews to current access and returns metadata only", async () => {
    const app = createApp();
    const emma = await login(app, "emma.acme");
    const preview = await app.inject({
      method: "POST",
      url: "/api/roles/preview",
      headers: auth(emma),
      payload: {
        draft: roleDraft({
          name: "Requested SAP master access",
          purpose: "analytics",
          ceiling: "restricted",
          products: ["s4_master"],
          tenants: [],
          regions: [],
          departments: [],
          denyFields: [],
          sources: ["sap"],
        }),
      },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ visible: 0, sample: [], previewMode: "metadata", constrainedToActor: true });
    expect(preview.json()).not.toHaveProperty("total");
    expect(preview.json().byDay).toEqual([]);
    expect(preview.json().byProduct.every((item: { amount?: number }) => item.amount === undefined)).toBe(true);
  });

  it("fails closed for disjoint preview dimensions and generated asks", async () => {
    const store = seedStore();
    applyRoleDraft(store, {
      actorId: "hugo.admin",
      principalId: "emma.acme",
      draft: roleDraft(),
    });
    const app = createApp(store);
    const emma = await login(app, "emma.acme");
    const headers = auth(emma);
    const disjointDrafts = [
      roleDraft({ name: "Wrong tenant", tenants: ["GLOBEX"] }),
      roleDraft({ name: "Wrong region", regions: ["EU"] }),
      roleDraft({ name: "Wrong department", departments: ["sales"] }),
      roleDraft({ name: "Wrong source", sources: ["sap"] }),
    ];

    for (const draft of disjointDrafts) {
      const response = await app.inject({
        method: "POST",
        url: "/api/roles/preview",
        headers,
        payload: { draft },
      });
      expect(response.statusCode, draft.name).toBe(200);
      expect(response.json(), draft.name).toMatchObject({
        visible: 0,
        denied: true,
        byProduct: [],
        byRegion: [],
        byDepartment: [],
        bySensitivity: [],
        constrainedToActor: true,
      });
    }

    const generated = await app.inject({
      method: "POST",
      url: "/api/roles/from-ask",
      headers,
      payload: { ask: "GLOBEX EU finance team only transactions" },
    });
    expect(generated.statusCode).toBe(200);
    expect(generated.json()).toMatchObject({
      draft: { tenants: ["GLOBEX"], regions: ["EU"], departments: ["finance"] },
      preview: { visible: 0, denied: true, constrainedToActor: true },
    });
  });

  it("returns opaque JIT errors to users while retaining administrator diagnostics", async () => {
    const app = createApp();
    const emma = await login(app, "emma.acme");
    const admin = await login(app, "hugo.admin");
    const rejected = await app.inject({
      method: "POST",
      url: "/api/jit",
      headers: auth(emma),
      payload: {
        datasetId: "bw_vendor",
        capsuleId: "vendor-globex",
        purpose: "vendor-performance",
        actions: ["view"],
        justification: "Probe a capsule that is not assigned",
        durationMs: 60_000,
      },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({
      error: "JIT request rejected",
      code: "jit_request_rejected",
    });
    expect(rejected.body).not.toContain("membership");
    expect(rejected.body).not.toContain("persona");

    const diagnostic = await app.inject({
      method: "POST",
      url: "/api/jit/missing-grant/approve",
      headers: auth(admin),
      payload: { ttlMs: 60_000 },
    });
    expect(diagnostic.statusCode).toBe(400);
    expect(diagnostic.json()).toMatchObject({ error: "unknown jit", code: "invalid_request" });
  });

  it("returns a clean conflict for an inactive compiler capsule", async () => {
    const store = seedStore();
    store.capsules.get("vendor-acme")!.active = false;
    const app = createApp(store);
    const admin = await login(app, "hugo.admin");
    const response = await app.inject({
      method: "GET",
      url: "/api/compiler/vendor-acme",
      headers: auth(admin),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "capsule is inactive", code: "capsule_inactive" });
  });

  it("binds a token purpose to purpose-bearing requests", async () => {
    const app = createApp();
    const token = await signAccessToken({
      sub: "emma.acme",
      persona: "consumer",
      capsules: ["vendor-acme"],
      authorizationFingerprint: authorizationFingerprintFor(seedStore(), "emma.acme"),
      kind: "human",
      purpose: "token-bound-purpose",
    });
    const headers = auth(token);
    const mismatches = [
      () => app.inject({
        method: "POST",
        url: "/api/pdp/check",
        headers,
        payload: { action: "view", datasetId: "bw_vendor", purpose: "analytics" },
      }),
      () => app.inject({ method: "GET", url: "/api/data/bw_vendor?purpose=analytics", headers }),
      () => app.inject({ method: "GET", url: "/api/dashboard?purpose=analytics", headers }),
      () => app.inject({
        method: "POST",
        url: "/api/jit",
        headers,
        payload: {
          datasetId: "bw_vendor",
          capsuleId: "vendor-acme",
          purpose: "vendor-performance",
          justification: "Purpose binding regression check",
          durationMs: 60_000,
        },
      }),
      () => app.inject({
        method: "POST",
        url: "/api/roles/preview",
        headers,
        payload: { draft: roleDraft() },
      }),
      () => app.inject({
        method: "POST",
        url: "/api/role-requests",
        headers,
        payload: { draft: roleDraft({ name: "Purpose-bound request" }) },
      }),
      () => app.inject({
        method: "POST",
        url: "/api/roles/from-ask",
        headers,
        payload: { ask: "ACME finance team only NA transactions" },
      }),
    ];

    for (const issue of mismatches) {
      const response = await issue();
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("purpose_mismatch");
    }

    const unscopedEmma = await login(app, "emma.acme");
    const jit = await app.inject({
      method: "POST",
      url: "/api/jit",
      headers: auth(unscopedEmma),
      payload: {
        datasetId: "bw_vendor",
        capsuleId: "vendor-acme",
        purpose: "vendor-performance",
        justification: "Create a grant for approval binding",
        durationMs: 60_000,
      },
    });
    expect(jit.statusCode).toBe(200);
    const roleRequest = await app.inject({
      method: "POST",
      url: "/api/role-requests",
      headers: auth(unscopedEmma),
      payload: { draft: roleDraft({ name: "Governance binding request" }) },
    });
    expect(roleRequest.statusCode).toBe(200);
    const scopedCatalog = await app.inject({ method: "GET", url: "/api/catalog", headers });
    expect(scopedCatalog.json().contracts).toEqual([]);
    expect(scopedCatalog.json().capsules).toEqual([]);
    const scopedJit = await app.inject({ method: "GET", url: "/api/jit", headers });
    expect(scopedJit.json().grants).toEqual([]);
    const scopedRequests = await app.inject({ method: "GET", url: "/api/role-requests", headers });
    expect(scopedRequests.json().requests).toEqual([]);
    const scopedExplain = await app.inject({ method: "GET", url: "/api/pdp/explain", headers });
    expect(scopedExplain.json().surfaces.every((surface: { rowCount: number }) => surface.rowCount === 0)).toBe(true);

    const scopedAdmin = await signAccessToken({
      sub: "hugo.admin",
      persona: "admin",
      capsules: ["control-plane"],
      authorizationFingerprint: authorizationFingerprintFor(seedStore(), "hugo.admin"),
      kind: "human",
      purpose: "vendor-performance",
    });
    const adminHeaders = auth(scopedAdmin);
    const governanceRequests = [
      () => app.inject({ method: "GET", url: "/api/catalog", headers: adminHeaders }),
      () => app.inject({ method: "GET", url: "/api/compiler", headers: adminHeaders }),
      () => app.inject({ method: "GET", url: "/api/audit", headers: adminHeaders }),
      () => app.inject({ method: "GET", url: "/api/jit", headers: adminHeaders }),
      () => app.inject({ method: "GET", url: "/api/role-requests", headers: adminHeaders }),
      () => app.inject({ method: "GET", url: "/api/roles/palette", headers: adminHeaders }),
      () => app.inject({
        method: "POST",
        url: "/api/pdp/check",
        headers: adminHeaders,
        payload: {
          action: "view",
          datasetId: "bw_vendor",
          principalId: "emma.acme",
          purpose: "vendor-performance",
        },
      }),
      () => app.inject({
        method: "POST",
        url: "/api/capsules/vendor-globex/members",
        headers: adminHeaders,
        payload: { principalId: "emma.acme" },
      }),
      () => app.inject({
        method: "POST",
        url: "/api/capsules/vendor-acme/offboard",
        headers: adminHeaders,
        payload: { cascade: false },
      }),
      () => app.inject({ method: "POST", url: "/api/store/reset", headers: adminHeaders }),
      () => app.inject({
        method: "POST",
        url: `/api/jit/${jit.json().id}/approve`,
        headers: adminHeaders,
        payload: { ttlMs: 60_000 },
      }),
      () => app.inject({
        method: "POST",
        url: `/api/role-requests/${roleRequest.json().id}/approve`,
        headers: adminHeaders,
      }),
      () => app.inject({
        method: "POST",
        url: "/api/roles/apply",
        headers: adminHeaders,
        payload: { principalId: "emma.acme", draft: roleDraft({ name: "Governance-bound direct role" }) },
      }),
      () => app.inject({
        method: "POST",
        url: "/api/roles/preview",
        headers: adminHeaders,
        payload: { draft: roleDraft({ name: "Governance-bound preview" }) },
      }),
    ];
    for (const issue of governanceRequests) {
      const response = await issue();
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("purpose_mismatch");
    }
  });

  it("returns a principal-scoped catalog and JIT list to ordinary users", async () => {
    const app = createApp();
    const emma = await login(app, "emma.acme");
    const catalog = await app.inject({ method: "GET", url: "/api/catalog", headers: auth(emma) });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().principals).toEqual([expect.objectContaining({ id: "emma.acme" })]);
    expect(catalog.json().memberships.every((item: { principalId: string }) => item.principalId === "emma.acme")).toBe(true);

    const jit = await app.inject({ method: "GET", url: "/api/jit", headers: auth(emma) });
    expect(jit.statusCode).toBe(200);
    expect(jit.json().grants).toEqual([]);
  });

  it("throttles repeated failed logins", async () => {
    const app = createApp(seedStore(), { loginRateLimit: { maxAttempts: 2, windowMs: 60_000, blockMs: 60_000 } });
    for (let index = 0; index < 2; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "emma.acme", password: "incorrect" },
      });
      expect(response.statusCode).toBe(401);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "emma.acme", password: "cca-demo" },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
  });

  it("bounds attacker-controlled login rate-limit keys", async () => {
    const app = createApp(seedStore(), {
      loginRateLimit: {
        maxAttempts: 2,
        windowMs: 60_000,
        blockMs: 60_000,
        maxTrackedKeys: 2,
      },
    });
    for (const username of ["unknown-a", "unknown-b", "unknown-c", "unknown-a", "unknown-a"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username, password: "incorrect" },
      });
      expect(response.statusCode, username).toBe(401);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "unknown-a", password: "incorrect" },
    });
    expect(blocked.statusCode).toBe(429);
  });

  it("limits browser origins and disables demo authentication in production mode", async () => {
    const app = createApp(seedStore(), { demoMode: false, corsOrigins: ["https://console.example.com"] });
    const directory = await app.inject({ method: "GET", url: "/api/auth/directory" });
    expect(directory.statusCode).toBe(404);
    const passwordLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "emma.acme", password: "cca-demo" },
    });
    expect(passwordLogin.statusCode).toBe(404);

    const allowed = await app.inject({ method: "OPTIONS", url: "/api/health", headers: { origin: "https://console.example.com", "access-control-request-method": "GET" } });
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://console.example.com");
    const denied = await app.inject({ method: "OPTIONS", url: "/api/health", headers: { origin: "https://untrusted.example", "access-control-request-method": "GET" } });
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("checks readiness without disclosing warehouse cardinality", async () => {
    const app = createApp();
    const response = await app.inject({ method: "GET", url: "/api/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, persistence: "memory" });
    expect(response.json()).not.toHaveProperty("warehouseRows");
  });

  it("requires a production JWT secret but permits explicit demo and test modes", () => {
    expect(() => assertJwtConfiguration({ CCA_MODE: "production" })).toThrow(/required/);
    expect(() => assertJwtConfiguration({ CCA_MODE: "production", CCA_JWT_SECRET: "short" })).toThrow(/32/);
    expect(() => assertJwtConfiguration({ CCA_MODE: "demo" })).not.toThrow();
    expect(() => assertJwtConfiguration({ CCA_MODE: "test" })).not.toThrow();
  });

  it("does not disclose internal error details", async () => {
    const persistence: ControlPlanePersistence = {
      save: () => { throw new Error("private database detail"); },
      check: () => undefined,
      close: () => undefined,
    };
    const app = createApp(seedStore(), { persistence });
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "emma.acme", password: "cca-demo" },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: "internal server error", code: "internal_error" });
    expect(response.body).not.toContain("private database detail");
  });

  it("rolls back security state when persistence fails", async () => {
    type RollbackContext = {
      app: FastifyInstance;
      store: ReturnType<typeof seedStore>;
      state: ReturnType<typeof createApiControlState>;
      admin: string;
      owner: string;
      emma: string;
    };
    type RollbackScenario = {
      name: string;
      prepare(context: RollbackContext): Promise<() => Promise<{ statusCode: number }>>;
    };

    const scenarios: RollbackScenario[] = [
      {
        name: "role approval",
        prepare: async ({ app, emma, admin }) => {
          const created = await app.inject({
            method: "POST",
            url: "/api/role-requests",
            headers: auth(emma),
            payload: { draft: roleDraft({ name: "Failed role approval" }) },
          });
          expect(created.statusCode).toBe(200);
          return async () => app.inject({
            method: "POST",
            url: `/api/role-requests/${created.json().id}/approve`,
            headers: auth(admin),
          });
        },
      },
      {
        name: "JIT request",
        prepare: async ({ app, emma }) => async () => app.inject({
          method: "POST",
          url: "/api/jit",
          headers: auth(emma),
          payload: {
            datasetId: "bw_vendor",
            capsuleId: "vendor-acme",
            purpose: "vendor-performance",
            actions: ["view"],
            justification: "Exercise failed persistence rollback",
            durationMs: 60_000,
          },
        }),
      },
      {
        name: "recertification creation",
        prepare: async ({ app, admin }) => async () => app.inject({
          method: "POST",
          url: "/api/recertifications",
          headers: auth(admin),
          payload: {
            name: "Failed quarterly review",
            dueAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
            cadenceDays: 90,
          },
        }),
      },
      {
        name: "recertification decision",
        prepare: async ({ app, admin, owner }) => {
          const campaign = await app.inject({
            method: "POST",
            url: "/api/recertifications",
            headers: auth(admin),
            payload: {
              name: "Rollback decision review",
              dueAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
              cadenceDays: 90,
            },
          });
          expect(campaign.statusCode).toBe(200);
          const target = (campaign.json().items as Array<{ id: string; principalId: string }>)
            .find((item) => item.principalId === "emma.acme")!;
          return async () => app.inject({
            method: "POST",
            url: `/api/recertifications/${campaign.json().id}/items/${target.id}/attest`,
            headers: auth(owner),
            payload: { reason: "This decision must roll back" },
          });
        },
      },
      {
        name: "JIT approval",
        prepare: async ({ app, emma, admin }) => {
          const created = await app.inject({
            method: "POST",
            url: "/api/jit",
            headers: auth(emma),
            payload: {
              datasetId: "bw_vendor",
              capsuleId: "vendor-acme",
              purpose: "vendor-performance",
              actions: ["view"],
              justification: "Exercise failed approval rollback",
              durationMs: 60_000,
            },
          });
          expect(created.statusCode).toBe(200);
          return async () => app.inject({
            method: "POST",
            url: `/api/jit/${created.json().id}/approve`,
            headers: auth(admin),
            payload: { ttlMs: 60_000 },
          });
        },
      },
      {
        name: "control-plane membership recovery add",
        prepare: async ({ app, store, admin }) => {
          store.memberships = store.memberships.filter((membership) => !(
            membership.principalId === "iris.admin"
            && membership.capsuleId === "control-plane"
          ));
          return async () => app.inject({
            method: "POST",
            url: "/api/capsules/control-plane/members",
            headers: auth(admin),
            payload: { principalId: "iris.admin" },
          });
        },
      },
      {
        name: "capsule offboard",
        prepare: async ({ app, admin }) => async () => app.inject({
          method: "POST",
          url: "/api/capsules/vendor-acme/offboard",
          headers: auth(admin),
          payload: { cascade: false },
        }),
      },
      {
        name: "store reset",
        prepare: async ({ app, admin }) => async () => app.inject({
          method: "POST",
          url: "/api/store/reset",
          headers: auth(admin),
        }),
      },
    ];

    for (const scenario of scenarios) {
      const store = seedStore();
      const state = createApiControlState();
      let rejectSave = false;
      const persistence: ControlPlanePersistence = {
        save: () => {
          if (rejectSave) throw new Error(`failed save: ${scenario.name}`);
        },
        check: () => undefined,
        close: () => undefined,
      };
      const app = createApp(store, { persistence, state });
      const emma = await login(app, "emma.acme");
      const admin = await login(app, "hugo.admin");
      const owner = await login(app, "dana.owner");
      const issueFailingRequest = await scenario.prepare({ app, store, state, admin, owner, emma });
      const storeBefore = store.snapshot();
      const stateBefore = structuredClone(state);

      rejectSave = true;
      const response = await issueFailingRequest();
      expect(response.statusCode, scenario.name).toBe(500);
      expect(store.snapshot(), scenario.name).toEqual(storeBefore);
      expect(state, scenario.name).toEqual(stateBefore);
    }
  });
});

describe("SQLite control-plane persistence", () => {
  it("restores applied roles, requests, JIT state, and audit sequence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cca-control-plane-test-"));
    const path = join(directory, "control.sqlite");
    try {
      const repository = new SqliteControlPlaneRepository(path);
      const store = seedStore();
      const state = createApiControlState();
      repository.save(store, state);
      const app = createApp(store, { persistence: repository, state });
      const emma = await login(app, "emma.acme");
      const admin = await login(app, "hugo.admin");
      const owner = await login(app, "dana.owner");
      const jit = await app.inject({
        method: "POST",
        url: "/api/jit",
        headers: auth(emma),
        payload: {
          datasetId: "bw_vendor",
          capsuleId: "vendor-acme",
          purpose: "vendor-performance",
          actions: ["view"],
          justification: "Review an upstream vendor synchronization issue",
          durationMs: 60_000,
        },
      });
      expect(jit.statusCode).toBe(200);
      const created = await app.inject({
        method: "POST",
        url: "/api/role-requests",
        headers: auth(emma),
        payload: { draft: roleDraft({ name: "Durable finance reviewer" }) },
      });
      const adminApproved = await app.inject({
        method: "POST",
        url: `/api/role-requests/${created.json().id}/approve`,
        headers: auth(admin),
      });
      expect(adminApproved.statusCode).toBe(200);
      expect(adminApproved.json().status).toBe("pending");
      const approved = await app.inject({
        method: "POST",
        url: `/api/role-requests/${created.json().id}/approve`,
        headers: auth(owner),
      });
      expect(approved.statusCode).toBe(200);
      const expectedPersona = approved.json().applied.personaId;
      const expectedAuditLength = store.audit.length;
      await app.close();
      apps.splice(apps.indexOf(app), 1);
      repository.close();

      const reopened = new SqliteControlPlaneRepository(path);
      const loaded = reopened.load();
      expect(loaded).toBeDefined();
      expect(loaded!.store.principals.get("emma.acme")!.personaId).toBe("consumer");
      expect(loaded!.store.memberships).toContainEqual(expect.objectContaining({
        principalId: "emma.acme",
        personaId: expectedPersona,
      }));
      expect(loaded!.state.roleRequests).toEqual([
        expect.objectContaining({ id: created.json().id, status: "approved", principalId: "emma.acme" }),
      ]);
      expect(loaded!.store.jit).toEqual([expect.objectContaining({ id: jit.json().id, status: "pending" })]);
      expect(loaded!.state.jitMetadata).toEqual([
        expect.objectContaining({ jitId: jit.json().id, requestedTtlMs: 60_000 }),
      ]);
      expect(loaded!.store.audit).toHaveLength(expectedAuditLength);
      loaded!.store.appendAudit("system", "persistence.verify", {});
      expect(loaded!.store.audit.at(-1)!.seq).toBe(expectedAuditLength + 1);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
