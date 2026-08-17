import { describe, expect, it } from "vitest";
import {
  SodPolicyViolationError,
  WAREHOUSE_SOD_RULES,
  applyRoleDraft,
  addMembership,
  evaluatePrincipalSod,
  evaluateRoleDraftSod,
  filterDataset,
  isControlPlaneAdmin,
  membershipAssignmentId,
  recertificationReviewerRolesFor,
  removeMembership,
  revokeMembershipForRecertification,
  seedStore,
  type RoleDraft,
} from "../src/index.js";

function draft(overrides: Partial<RoleDraft> = {}): RoleDraft {
  return {
    name: "Scoped warehouse role",
    verbs: ["view"],
    purpose: "analytics",
    ceiling: "confidential",
    products: ["transactions"],
    tenants: ["ACME"],
    regions: ["NA"],
    departments: ["finance"],
    denyFields: ["account_number"],
    sources: ["generic"],
    ...overrides,
  };
}

describe("warehouse separation-of-duties policy", () => {
  it("publishes versioned, explainable rules and starts with no seeded violations", () => {
    const store = seedStore();
    expect(WAREHOUSE_SOD_RULES.map((rule) => rule.id)).toEqual([
      "SOD-WH-001",
      "SOD-WH-002",
      "SOD-WH-003",
    ]);
    expect(WAREHOUSE_SOD_RULES.every((rule) =>
      rule.version > 0 && Boolean(rule.rationale) && Boolean(rule.remediation)
    )).toBe(true);
    expect(WAREHOUSE_SOD_RULES.every((rule) =>
      Object.isFrozen(rule) && Object.isFrozen(rule.left) && Object.isFrozen(rule.right)
    )).toBe(true);
    for (const principal of store.principals.values()) {
      expect(evaluatePrincipalSod(store, principal.id), principal.id).toEqual([]);
    }
    expect(isControlPlaneAdmin(store, "hugo.admin")).toBe(true);
    expect(isControlPlaneAdmin(store, "iris.admin")).toBe(true);
    expect(store.datasets.get("warehouse")?.ownerPrincipalIds).toEqual(["dana.owner"]);
    expect(filterDataset(store, "iris.admin", "bw_vendor", "governance").records).toEqual([]);
  });

  it("finds toxic capability combinations inside a draft and across standing access", () => {
    const store = seedStore();
    expect(evaluateRoleDraftSod(store, "emma.acme", draft({
      verbs: ["operate"],
      purpose: "operations",
      products: ["s4_master", "transactions"],
      sources: ["sap", "generic"],
      ceiling: "restricted",
    }))).toEqual([
      expect.objectContaining({
        ruleId: "SOD-WH-001",
        severity: "critical",
        evidence: expect.objectContaining({
          left: expect.objectContaining({ source: "candidate" }),
          right: expect.objectContaining({ source: "candidate" }),
        }),
      }),
    ]);

    const accumulated = evaluateRoleDraftSod(store, "ben.l2bw", draft({
      verbs: ["operate"],
      purpose: "operations",
      products: ["s4_master"],
      tenants: [],
      regions: [],
      departments: [],
      sources: ["sap"],
      ceiling: "restricted",
    }));
    expect(accumulated).toEqual([
      expect.objectContaining({
        ruleId: "SOD-WH-001",
        evidence: expect.objectContaining({
          left: expect.objectContaining({ source: "candidate" }),
          right: expect.objectContaining({ source: "standing", principalId: "ben.l2bw" }),
        }),
      }),
    ]);
  });

  it("fails closed before apply mutates any authorization state", () => {
    const store = seedStore();
    const before = store.snapshot();
    expect(() => applyRoleDraft(store, {
      actorId: "hugo.admin",
      principalId: "emma.acme",
      draft: draft({ verbs: ["operate"], purpose: "audit" }),
    })).toThrow(SodPolicyViolationError);
    expect(store.snapshot()).toEqual(before);
    expect(() => applyRoleDraft(store, {
      actorId: "hugo.admin",
      principalId: "iris.admin",
      draft: draft(),
    })).toThrow(/administrator roles cannot be replaced/);
  });
});

describe("recertification membership enforcement", () => {
  it("assigns independent reviewer roles and lets a data owner revoke ordinary access", () => {
    const store = seedStore();
    expect(recertificationReviewerRolesFor(store, "hugo.admin", "control-plane")).toEqual(["data-owner"]);
    expect(recertificationReviewerRolesFor(store, "dana.owner", "data-governance-owner"))
      .toEqual(["governance-admin"]);
    expect(recertificationReviewerRolesFor(store, "emma.acme", "vendor-acme"))
      .toEqual(["data-owner", "governance-admin"]);

    revokeMembershipForRecertification(store, {
      reviewerId: "dana.owner",
      principalId: "emma.acme",
      capsuleId: "vendor-acme",
      campaignId: "campaign-1",
      itemId: "item-1",
      assignmentId: membershipAssignmentId(store.memberships.find((membership) =>
        membership.principalId === "emma.acme" && membership.capsuleId === "vendor-acme"
      )!),
      reason: "Business ownership ended",
      now: 10_000,
    });
    expect(store.memberships).not.toContainEqual(expect.objectContaining({
      principalId: "emma.acme",
      capsuleId: "vendor-acme",
    }));
    expect(store.audit.at(-1)).toMatchObject({
      actorId: "dana.owner",
      type: "membership.remove",
      detail: { recertification: { campaignId: "campaign-1", itemId: "item-1" } },
    });
  });

  it("blocks self-review and removal of the last active administrator", () => {
    const store = seedStore();
    expect(() => revokeMembershipForRecertification(store, {
      reviewerId: "dana.owner",
      principalId: "dana.owner",
      capsuleId: "data-governance-owner",
      campaignId: "campaign-1",
      itemId: "item-owner",
      assignmentId: membershipAssignmentId(store.memberships.find((membership) =>
        membership.principalId === "dana.owner" && membership.capsuleId === "data-governance-owner"
      )!),
      reason: "self removal",
    })).toThrow(/self_review/);
    removeMembership(store, "hugo.admin", "iris.admin", "control-plane");
    expect(() => revokeMembershipForRecertification(store, {
      reviewerId: "dana.owner",
      principalId: "hugo.admin",
      capsuleId: "control-plane",
      campaignId: "campaign-1",
      itemId: "item-admin",
      assignmentId: membershipAssignmentId(store.memberships.find((membership) =>
        membership.principalId === "hugo.admin" && membership.capsuleId === "control-plane"
      )!),
      reason: "remove admin",
    })).toThrow(/last active control-plane administrator/);
  });

  it("detects remove-and-readd instead of attesting a replacement assignment", () => {
    const store = seedStore();
    const original = store.memberships.find((membership) =>
      membership.principalId === "emma.acme" && membership.capsuleId === "vendor-acme"
    )!;
    const originalAssignmentId = membershipAssignmentId(original);
    removeMembership(store, "hugo.admin", "emma.acme", "vendor-acme");
    expect(() => addMembership(store, "hugo.admin", "emma.acme", "vendor-acme"))
      .toThrow(/role-request approval workflow/);
    store.memberships.push({
      principalId: "emma.acme",
      capsuleId: "vendor-acme",
      personaId: "consumer",
      assignmentId: "assignment.recertification-replacement",
    });
    const replacement = store.memberships.find((membership) =>
      membership.principalId === "emma.acme" && membership.capsuleId === "vendor-acme"
    )!;
    expect(membershipAssignmentId(replacement)).not.toBe(originalAssignmentId);
    expect(() => revokeMembershipForRecertification(store, {
      reviewerId: "dana.owner",
      principalId: "emma.acme",
      capsuleId: "vendor-acme",
      campaignId: "campaign-1",
      itemId: "old-item",
      assignmentId: originalAssignmentId,
      reason: "old assignment",
    })).toThrow(/assignment changed/);
  });
});
