import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { seedStore, type RoleDraft } from "@cca/core";
import { buildApp } from "../src/app.js";
import {
  createApiControlState,
  SqliteControlPlaneRepository,
  type ApiControlState,
} from "../src/control-plane.js";

const apps: FastifyInstance[] = [];
const directories: string[] = [];

function createApp(
  store = seedStore(),
  state: ApiControlState = createApiControlState(),
  options: Omit<Parameters<typeof buildApp>[1], "state"> = {},
) {
  const app = buildApp(store, { ...options, state });
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
    name: "ACME finance analyst",
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
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("governance policy APIs", () => {
  it("returns explainable SoD policy and blocks toxic drafts at preview/request/apply boundaries", async () => {
    const app = createApp();
    const emma = await login(app, "emma.acme");
    const admin = await login(app, "hugo.admin");
    const owner = await login(app, "dana.owner");
    const toxic = roleDraft({
      name: "Vendor master and finance operator",
      verbs: ["operate"],
      purpose: "operations",
      ceiling: "restricted",
      products: ["s4_master", "transactions"],
      tenants: [],
      regions: [],
      departments: [],
      denyFields: [],
      sources: ["sap", "generic"],
    });

    const rules = await app.inject({ method: "GET", url: "/api/governance/sod/rules", headers: auth(owner) });
    expect(rules.statusCode).toBe(200);
    expect(rules.json()).toMatchObject({ failClosed: true });
    expect(rules.json().rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "SOD-WH-001", version: 1, severity: "critical" }),
    ]));
    const ordinaryRules = await app.inject({
      method: "GET",
      url: "/api/governance/sod/rules",
      headers: auth(emma),
    });
    expect(ordinaryRules.statusCode).toBe(403);

    const preview = await app.inject({
      method: "POST",
      url: "/api/roles/preview",
      headers: auth(admin),
      payload: { draft: toxic },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().sodViolations).toEqual([
      expect.objectContaining({ ruleId: "SOD-WH-001", remediation: expect.any(String) }),
    ]);

    const accumulatedPreview = await app.inject({
      method: "POST",
      url: "/api/roles/preview",
      headers: auth(admin),
      payload: {
        principalId: "ben.l2bw",
        draft: roleDraft({
          name: "Add vendor master operation",
          verbs: ["operate"],
          purpose: "operations",
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
    expect(accumulatedPreview.json()).toMatchObject({
      sodEvaluatedPrincipalId: "ben.l2bw",
      sodViolations: [{
        ruleId: "SOD-WH-001",
        evidence: { right: { source: "standing", principalId: "ben.l2bw" } },
      }],
    });

    const request = await app.inject({
      method: "POST",
      url: "/api/role-requests",
      headers: auth(emma),
      payload: { draft: toxic },
    });
    expect(request.statusCode).toBe(409);
    expect(request.json()).toMatchObject({
      code: "sod_policy_violation",
      details: { violations: [expect.objectContaining({ ruleId: "SOD-WH-001" })] },
    });

    const direct = await app.inject({
      method: "POST",
      url: "/api/roles/apply",
      headers: auth(admin),
      payload: { principalId: "emma.acme", draft: roleDraft() },
    });
    expect(direct.statusCode).toBe(409);
    expect(direct.json().code).toBe("approval_workflow_required");
  });

  it("requires independent data-owner and governance-admin approvals before applying", async () => {
    const store = seedStore();
    const dana = store.principals.get("dana.owner")!;
    store.principals.set("drew.owner", {
      ...structuredClone(dana),
      id: "drew.owner",
      username: "drew.owner",
      displayName: "Drew Morgan",
    });
    store.memberships.push({
      principalId: "drew.owner",
      capsuleId: "data-governance-owner",
      personaId: "data-owner",
      assignmentId: "test-assignment-drew-owner",
    });
    store.datasets.get("warehouse")!.ownerPrincipalIds!.push("drew.owner");
    const app = createApp(store);
    const emma = await login(app, "emma.acme");
    const admin = await login(app, "hugo.admin");
    const owner = await login(app, "dana.owner");
    const created = await app.inject({
      method: "POST",
      url: "/api/role-requests",
      headers: auth(emma),
      payload: { draft: roleDraft() },
    });
    expect(created.json()).toMatchObject({
      status: "pending",
      approvalPolicyVersion: 2,
      requiredApprovals: ["data-owner", "governance-admin"],
      approvals: [],
    });

    const ownerQueue = await app.inject({ method: "GET", url: "/api/role-requests", headers: auth(owner) });
    expect(ownerQueue.json().requests).toEqual([
      expect.objectContaining({ id: created.json().id }),
    ]);

    const first = await app.inject({
      method: "POST",
      url: `/api/role-requests/${created.json().id}/approve`,
      headers: auth(owner),
    });
    expect(first.json()).toMatchObject({
      status: "pending",
      approvals: [expect.objectContaining({ reviewerRole: "data-owner", decision: "approved" })],
    });
    expect(first.json()).not.toHaveProperty("applied");

    const repeated = await app.inject({
      method: "POST",
      url: `/api/role-requests/${created.json().id}/approve`,
      headers: auth(owner),
    });
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json().code).toBe("approval_already_recorded");

    const final = await app.inject({
      method: "POST",
      url: `/api/role-requests/${created.json().id}/approve`,
      headers: auth(admin),
    });
    expect(final.statusCode).toBe(200);
    expect(final.json()).toMatchObject({
      status: "approved",
      applied: { personaId: expect.stringMatching(/^capability\./) },
    });
    expect(final.json().approvals).toHaveLength(2);

    const secondAdmin = await login(app, "iris.admin");
    const adminAuthored = await app.inject({
      method: "POST",
      url: "/api/role-requests",
      headers: auth(admin),
      payload: {
        principalId: "emma.acme",
        draft: roleDraft({
          name: "Admin-authored ACME inventory analyst",
          purpose: "analytics",
          products: ["inventory"],
          departments: ["ops"],
        }),
      },
    });
    expect(adminAuthored.statusCode).toBe(200);
    expect(adminAuthored.json()).toMatchObject({ requesterId: "hugo.admin", principalId: "emma.acme" });
    const secondAdminApproval = await app.inject({
      method: "POST",
      url: `/api/role-requests/${adminAuthored.json().id}/approve`,
      headers: auth(secondAdmin),
    });
    expect(secondAdminApproval.json()).toMatchObject({
      status: "pending",
      approvals: [expect.objectContaining({ reviewerId: "iris.admin", reviewerRole: "governance-admin" })],
    });
    const ownerFinal = await app.inject({
      method: "POST",
      url: `/api/role-requests/${adminAuthored.json().id}/approve`,
      headers: auth(owner),
    });
    expect(ownerFinal.json()).toMatchObject({
      status: "approved",
      approvals: [
        expect.objectContaining({ reviewerId: "iris.admin" }),
        expect.objectContaining({ reviewerId: "dana.owner" }),
      ],
    });
    const protectedAdminTarget = await app.inject({
      method: "POST",
      url: "/api/role-requests",
      headers: auth(admin),
      payload: { principalId: "iris.admin", draft: roleDraft({ name: "Replace second administrator" }) },
    });
    expect(protectedAdminTarget.statusCode).toBe(409);
    expect(protectedAdminTarget.json().code).toBe("admin_role_protected");

    const selfTarget = await app.inject({
      method: "POST",
      url: "/api/role-requests",
      headers: auth(owner),
      payload: { draft: roleDraft({ name: "Owner analytics" }) },
    });
    expect(selfTarget.statusCode).toBe(200);
    const selfApproval = await app.inject({
      method: "POST",
      url: `/api/role-requests/${selfTarget.json().id}/approve`,
      headers: auth(owner),
    });
    expect(selfApproval.statusCode).toBe(409);
    expect(selfApproval.json().code).toBe("self_approval_forbidden");

    const finn = await login(app, "finn.globex");
    const crossRoleRequest = await app.inject({
      method: "POST",
      url: "/api/role-requests",
      headers: auth(finn),
      payload: { draft: roleDraft({ name: "Globex finance analyst", tenants: ["GLOBEX"] }) },
    });
    const ownerApproval = await app.inject({
      method: "POST",
      url: `/api/role-requests/${crossRoleRequest.json().id}/approve`,
      headers: auth(owner),
    });
    expect(ownerApproval.json().status).toBe("pending");
    store.principals.get("dana.owner")!.personaId = "admin";
    store.memberships.push({
      principalId: "dana.owner",
      capsuleId: "control-plane",
      personaId: "admin",
      assignmentId: "test-assignment-dana-admin",
    });
    const ownerAsAdmin = await login(app, "dana.owner");
    const sameHumanSecondRole = await app.inject({
      method: "POST",
      url: `/api/role-requests/${crossRoleRequest.json().id}/approve`,
      headers: auth(ownerAsAdmin),
    });
    expect(sameHumanSecondRole.statusCode).toBe(409);
    expect(sameHumanSecondRole.json().code).toBe("approval_already_recorded");
  });

  it("rejects requests that cannot be completed by independent required reviewers", async () => {
    const store = seedStore();
    store.memberships = store.memberships.filter((membership) => membership.principalId !== "dana.owner");
    const app = createApp(store);
    const emma = await login(app, "emma.acme");
    const response = await app.inject({
      method: "POST",
      url: "/api/role-requests",
      headers: auth(emma),
      payload: { draft: roleDraft() },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "independent_reviewer_unavailable",
      details: { missingReviewerRoles: ["data-owner"] },
    });
  });
});

describe("recurring access recertification", () => {
  it("creates, pages, independently decides, revokes, and emits verifiable evidence", async () => {
    const store = seedStore();
    const state = createApiControlState();
    const app = createApp(store, state);
    const admin = await login(app, "hugo.admin");
    const owner = await login(app, "dana.owner");
    const created = await app.inject({
      method: "POST",
      url: "/api/recertifications",
      headers: auth(admin),
      payload: {
        name: "Quarterly human access review",
        dueAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        cadenceDays: 90,
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      status: "active",
      cadenceDays: 90,
      itemCount: 10,
      counts: { pending: 10 },
    });
    const campaignId = created.json().id as string;

    const pageOne = await app.inject({
      method: "GET",
      url: `/api/recertifications/${campaignId}/items?limit=2`,
      headers: auth(owner),
    });
    expect(pageOne.statusCode).toBe(200);
    expect(pageOne.json().items).toHaveLength(2);
    expect(pageOne.json().nextCursor).toBe(2);

    const all = await app.inject({
      method: "GET",
      url: `/api/recertifications/${campaignId}/items`,
      headers: auth(owner),
    });
    const items = all.json().items as Array<{
      id: string;
      principalId: string;
      eligibleReviewerRoles: string[];
    }>;
    const byPrincipal = new Map(items.map((item) => [item.principalId, item]));
    expect(byPrincipal.get("hugo.admin")?.eligibleReviewerRoles).toEqual(["data-owner"]);
    expect(byPrincipal.get("dana.owner")?.eligibleReviewerRoles).toEqual(["governance-admin"]);

    const oldAnaAssignment = (items.find((item) => item.principalId === "ana.l1") as typeof items[number] & {
      assignmentId: string;
    }).assignmentId;
    const removedAna = await app.inject({
      method: "DELETE",
      url: "/api/capsules/support-l1/members/ana.l1",
      headers: auth(admin),
    });
    expect(removedAna.statusCode).toBe(200);
    const readdedAna = await app.inject({
      method: "POST",
      url: "/api/capsules/support-l1/members",
      headers: auth(admin),
      payload: { principalId: "ana.l1" },
    });
    expect(readdedAna.statusCode).toBe(409);
    expect(readdedAna.json().code).toBe("approval_workflow_required");
    store.memberships.push({
      principalId: "ana.l1",
      capsuleId: "support-l1",
      personaId: "l1",
      assignmentId: "assignment.recertification-replacement",
    });
    const replacement = store.memberships.find((membership) =>
      membership.principalId === "ana.l1" && membership.capsuleId === "support-l1"
    )!;
    expect(replacement.assignmentId).not.toBe(oldAnaAssignment);
    const attestReplacementThroughOldItem = await app.inject({
      method: "POST",
      url: `/api/recertifications/${campaignId}/items/${byPrincipal.get("ana.l1")!.id}/attest`,
      headers: auth(owner),
      payload: { reason: "Attempt to attest the replacement assignment" },
    });
    expect(attestReplacementThroughOldItem.statusCode).toBe(409);
    expect(attestReplacementThroughOldItem.json().code).toBe("recertification_item_decided");

    const selfReview = await app.inject({
      method: "POST",
      url: `/api/recertifications/${campaignId}/items/${byPrincipal.get("dana.owner")!.id}/attest`,
      headers: auth(owner),
      payload: { reason: "My access is still needed" },
    });
    expect(selfReview.statusCode).toBe(409);
    expect(selfReview.json().code).toBe("self_review_forbidden");

    const attested = await app.inject({
      method: "POST",
      url: `/api/recertifications/${campaignId}/items/${byPrincipal.get("emma.acme")!.id}/attest`,
      headers: auth(owner),
      payload: { reason: "Vendor analytics remains an active responsibility" },
    });
    expect(attested.statusCode).toBe(200);
    expect(attested.json().item).toMatchObject({
      status: "attested",
      decidedBy: "dana.owner",
      reviewerRole: "data-owner",
      evidence: {
        auditSeq: expect.any(Number),
        auditHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        membershipFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });

    const revoked = await app.inject({
      method: "POST",
      url: `/api/recertifications/${campaignId}/items/${byPrincipal.get("finn.globex")!.id}/revoke`,
      headers: auth(owner),
      payload: { reason: "Globex team assignment ended" },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().item.status).toBe("revoked");
    expect(store.memberships).not.toContainEqual(expect.objectContaining({
      principalId: "finn.globex",
      capsuleId: "vendor-globex",
    }));

    const removedSecondAdmin = await app.inject({
      method: "POST",
      url: `/api/recertifications/${campaignId}/items/${byPrincipal.get("iris.admin")!.id}/revoke`,
      headers: auth(owner),
      payload: { reason: "Second administrator assignment is no longer required" },
    });
    expect(removedSecondAdmin.statusCode).toBe(200);
    expect(removedSecondAdmin.json().item.status).toBe("revoked");

    const lastAdmin = await app.inject({
      method: "POST",
      url: `/api/recertifications/${campaignId}/items/${byPrincipal.get("hugo.admin")!.id}/revoke`,
      headers: auth(owner),
      payload: { reason: "Attempt to remove the sole administrator" },
    });
    expect(lastAdmin.statusCode).toBe(400);
    expect(store.memberships).toContainEqual(expect.objectContaining({
      principalId: "hugo.admin",
      capsuleId: "control-plane",
    }));

    const adminAttestsOwner = await app.inject({
      method: "POST",
      url: `/api/recertifications/${campaignId}/items/${byPrincipal.get("dana.owner")!.id}/attest`,
      headers: auth(admin),
      payload: { reason: "Data ownership remains assigned" },
    });
    expect(adminAttestsOwner.statusCode).toBe(200);

    const evidence = await app.inject({
      method: "GET",
      url: `/api/recertifications/${campaignId}/evidence`,
      headers: auth(owner),
    });
    expect(evidence.statusCode).toBe(200);
    expect(evidence.json().auditChainValid).toBe(true);
    expect(evidence.json().decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ principalId: "emma.acme", status: "attested" }),
      expect.objectContaining({ principalId: "finn.globex", status: "revoked" }),
      expect.objectContaining({ principalId: "dana.owner", status: "attested" }),
      expect.objectContaining({ principalId: "ana.l1", status: "removed" }),
      expect.objectContaining({ principalId: "iris.admin", status: "revoked" }),
    ]));
  });

  it("expires overdue campaigns and renews the recurring schedule exactly once", async () => {
    const state = createApiControlState();
    const app = createApp(seedStore(), state);
    const admin = await login(app, "hugo.admin");
    const created = await app.inject({
      method: "POST",
      url: "/api/recertifications",
      headers: auth(admin),
      payload: {
        name: "Monthly access review",
        dueAt: Date.now() + DAY,
        cadenceDays: 30,
      },
    });
    const campaignId = created.json().id as string;
    state.recertifications.find((campaign) => campaign.id === campaignId)!.dueAt = Date.now() - 1;

    const refreshed = await app.inject({ method: "GET", url: "/api/recertifications", headers: auth(admin) });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().campaigns).toEqual([
      expect.objectContaining({ id: campaignId, status: "expired" }),
    ]);

    const renewed = await app.inject({
      method: "POST",
      url: `/api/recertifications/${campaignId}/renew`,
      headers: auth(admin),
    });
    expect(renewed.statusCode).toBe(200);
    expect(renewed.json()).toMatchObject({
      status: "active",
      previousCampaignId: campaignId,
      cadenceDays: 30,
    });
    const repeated = await app.inject({
      method: "POST",
      url: `/api/recertifications/${campaignId}/renew`,
      headers: auth(admin),
    });
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json().code).toBe("recertification_already_renewed");
  });
});

describe("governance persistence migration", () => {
  it("migrates v1 API state to dual approval and initializes recertification state", () => {
    const directory = mkdtempSync(join(tmpdir(), "cca-governance-migration-"));
    directories.push(directory);
    const path = join(directory, "control.sqlite");
    const repository = new SqliteControlPlaneRepository(path);
    repository.save(seedStore(), createApiControlState());
    repository.close();

    const db = new DatabaseSync(path);
    try {
      const row = db.prepare("SELECT payload FROM control_plane_state WHERE id = 1").get() as { payload: string };
      const envelope = JSON.parse(row.payload) as Record<string, any>;
      envelope.api = {
        version: 1,
        roleRequests: [{
          id: "legacy-pending-request",
          requesterId: "emma.acme",
          principalId: "emma.acme",
          status: "pending",
          draft: roleDraft(),
          createdAt: 100,
        }],
        jitMetadata: [],
      };
      db.prepare("UPDATE control_plane_state SET payload = ? WHERE id = 1").run(JSON.stringify(envelope));
    } finally {
      db.close();
    }

    const reopened = new SqliteControlPlaneRepository(path, { requireExisting: true });
    const loaded = reopened.load("production")!;
    expect(loaded.state).toMatchObject({ version: 2, recertifications: [] });
    expect(loaded.state.roleRequests).toEqual([
      expect.objectContaining({
        id: "legacy-pending-request",
        approvalPolicyVersion: 2,
        requiredApprovals: ["data-owner", "governance-admin"],
        approvals: [],
      }),
    ]);
    expect(loaded.store.audit.at(-1)?.type).toBe("api-state.migrate.v1-v2");
    reopened.close();

    const verified = new DatabaseSync(path, { readOnly: true });
    try {
      const row = verified.prepare("SELECT payload FROM control_plane_state WHERE id = 1").get() as { payload: string };
      const persisted = JSON.parse(row.payload) as { api: { version: number } };
      expect(persisted.api.version).toBe(2);
    } finally {
      verified.close();
    }
  });

  it("rejects persisted self-approvals and one identity recorded for two reviewer roles", () => {
    const cases = [
      {
        name: "self approval",
        request: {
          id: "invalid-self",
          requesterId: "dana.owner",
          principalId: "dana.owner",
          status: "pending" as const,
          draft: roleDraft(),
          createdAt: 100,
          approvalPolicyVersion: 2 as const,
          requiredApprovals: ["data-owner", "governance-admin"] as const,
          approvals: [{
            reviewerId: "dana.owner",
            reviewerRole: "data-owner" as const,
            decision: "approved" as const,
            decidedAt: 101,
          }],
        },
        error: /independent-review policy/,
      },
      {
        name: "same reviewer twice",
        request: {
          id: "invalid-duplicate",
          requesterId: "emma.acme",
          principalId: "emma.acme",
          status: "pending" as const,
          draft: roleDraft(),
          createdAt: 100,
          approvalPolicyVersion: 2 as const,
          requiredApprovals: ["data-owner", "governance-admin"] as const,
          approvals: [
            {
              reviewerId: "dana.owner",
              reviewerRole: "data-owner" as const,
              decision: "approved" as const,
              decidedAt: 101,
            },
            {
              reviewerId: "dana.owner",
              reviewerRole: "governance-admin" as const,
              decision: "approved" as const,
              decidedAt: 102,
            },
          ],
        },
        error: /duplicate role request reviewer identity/,
      },
    ];

    for (const testCase of cases) {
      const directory = mkdtempSync(join(tmpdir(), "cca-governance-invalid-"));
      directories.push(directory);
      const path = join(directory, "control.sqlite");
      const repository = new SqliteControlPlaneRepository(path);
      const state = createApiControlState();
      state.roleRequests.push(testCase.request as unknown as ApiControlState["roleRequests"][number]);
      repository.save(seedStore(), state);
      repository.close();
      expect(
        () => new SqliteControlPlaneRepository(path, { requireExisting: true }),
        testCase.name,
      ).toThrow(testCase.error);
    }
  });
});

const DAY = 24 * 60 * 60 * 1000;
