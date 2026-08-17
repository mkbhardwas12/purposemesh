import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App, RecordTable } from "./App";
import { api, ApiError, setToken, tokenExpiresAt, type Catalog, type CompiledPolicy, type DashboardPayload, type JitGrant, type Principal, type RecertificationCampaignSummary, type RecertificationItem, type RoleDraft, type RolePalette, type RoleRequest, type SodViolation } from "./api";
import { decisionLabel, visibleVendorIds } from "./format";
import { applyToken, emptyDraft, formatCount, validateDraft } from "./roleDraft";

const dashboard: DashboardPayload = {
  total: 1000,
  visible: 120,
  denied: false,
  byProduct: [{ key: "transactions", count: 120, amount: 20_000 }],
  byRegion: [{ key: "NA", count: 120 }],
  byDepartment: [{ key: "finance", count: 120 }],
  bySensitivity: [{ key: "internal", count: 120 }],
  byDay: [{ key: "2026-08-14", count: 60 }, { key: "2026-08-15", count: 60 }],
  sample: [],
};

const businessUser: Principal = {
  id: "emma.acme",
  username: "emma.acme",
  displayName: "Emma Patel",
  personaId: "consumer",
  personaLabel: "Business consumer",
  kind: "human",
  actions: ["view"],
  ceiling: "confidential",
  capsules: [{ id: "vendor-acme", label: "Vendor ACME", purpose: "vendor-performance" }],
};

const adminUser: Principal = {
  ...businessUser,
  id: "hugo.admin",
  username: "hugo.admin",
  displayName: "Hugo Meyer",
  personaId: "admin",
  personaLabel: "Platform admin",
  actions: ["view", "administer", "audit"],
  ceiling: "restricted",
  capsules: [{ id: "control-plane", label: "Control plane", purpose: "governance" }],
};

const dataOwnerUser: Principal = {
  ...businessUser,
  id: "dana.owner",
  username: "dana.owner",
  displayName: "Dana Rivera",
  personaId: "data-owner",
  personaLabel: "Data owner",
  actions: ["view", "audit"],
  ceiling: "restricted",
  capsules: [{ id: "data-governance-owner", label: "Data governance owner", purpose: "data-governance" }],
};

const globexUser: Principal = {
  ...businessUser,
  id: "finn.globex",
  username: "finn.globex",
  displayName: "Finn Okafor",
  capsules: [{ id: "vendor-globex", label: "Vendor Globex", purpose: "vendor-performance" }],
};

const palette: RolePalette = {
  verbs: [{ id: "view", label: "view", group: "verb" }],
  purposes: [{ id: "finance", label: "finance", group: "purpose" }],
  ceilings: [
    { id: "internal", label: "internal", group: "ceiling" },
    { id: "confidential", label: "confidential", group: "ceiling" },
  ],
  products: [{ id: "transactions", label: "transactions", group: "product" }],
  tenants: [{ id: "ACME", label: "ACME", group: "tenant" }],
  regions: [{ id: "NA", label: "NA", group: "region" }],
  departments: [{ id: "finance", label: "finance", group: "department" }],
  masks: [{ id: "account_number", label: "hide account", group: "mask" }],
  sources: [{ id: "generic", label: "generic", group: "source" }],
};

const catalog: Catalog = {
  personas: [],
  capsules: [{ id: "control-plane", label: "Control plane", purpose: "governance", active: true }],
  datasets: [],
  contracts: [{ id: "wh.analytics", datasetId: "warehouse", purpose: "analytics" }],
  bindings: [],
  memberships: [],
  principals: [
    { id: "hugo.admin", displayName: "Hugo Meyer", username: "hugo.admin", personaId: "admin", kind: "human" },
    { id: "emma.acme", displayName: "Emma Patel", username: "emma.acme", personaId: "consumer", kind: "human" },
    { id: "finn.globex", displayName: "Finn Clarke", username: "finn.globex", personaId: "consumer", kind: "human" },
  ],
};

const jitCatalog: Catalog = {
  ...catalog,
  personas: [{ id: "consumer", label: "Business consumer", actions: ["view"], ceiling: "confidential" }],
  capsules: [{ id: "vendor-acme", label: "Vendor ACME", purpose: "vendor-performance", active: true }],
  datasets: [{
    id: "s4_vendor",
    name: "S/4 vendor master",
    origin: "S/4HANA",
    classification: "restricted",
    controlPlane: false,
    allowedFields: ["vendor_id", "legal_name", "bank_account", "tax_id"],
  }],
  contracts: [{
    id: "jit.acme.vendor-diagnostic",
    datasetId: "s4_vendor",
    purpose: "vendor-performance",
    allowedPersonas: ["consumer"],
    actions: ["view"],
    classificationMax: "confidential",
    predicate: { op: "fromCapsuleAttr", field: "vendor_id", attr: "vendor_set" },
    allowFields: ["vendor_id", "legal_name"],
    denyFields: ["bank_account", "tax_id"],
    approvalRequired: true,
  }],
  bindings: [{ id: "bind-jit-acme", capsuleId: "vendor-acme", contractId: "jit.acme.vendor-diagnostic" }],
  memberships: [{ principalId: businessUser.id, capsuleId: "vendor-acme" }],
};

const completeDraft: RoleDraft = {
  name: "NA finance analyst",
  verbs: ["view"],
  purpose: "finance",
  ceiling: "internal",
  products: ["transactions"],
  tenants: [],
  regions: ["NA"],
  departments: ["finance"],
  denyFields: ["account_number"],
  sources: ["generic"],
};

function roleRequest(status: RoleRequest["status"], id: string): RoleRequest {
  const decidedAt = Date.now();
  const approvals: RoleRequest["approvals"] = status === "approved" ? [
    { reviewerId: dataOwnerUser.id, reviewerRole: "data-owner", decision: "approved", decidedAt },
    { reviewerId: adminUser.id, reviewerRole: "governance-admin", decision: "approved", decidedAt },
  ] : status === "denied" ? [
    { reviewerId: dataOwnerUser.id, reviewerRole: "data-owner", decision: "denied", decidedAt, reason: "Not required" },
  ] : [];
  return {
    id,
    requesterId: businessUser.id,
    principalId: businessUser.id,
    status,
    draft: completeDraft,
    createdAt: Date.now(),
    approvalPolicyVersion: 2,
    requiredApprovals: ["data-owner", "governance-admin"],
    approvals,
  };
}

function recertificationCampaign(overrides: Partial<RecertificationCampaignSummary> = {}): RecertificationCampaignSummary {
  return {
    id: "recert-q3",
    name: "Q3 standing access review",
    createdBy: adminUser.id,
    createdAt: Date.now() - 86_400_000,
    dueAt: Date.now() + 30 * 86_400_000,
    cadenceDays: 90,
    nextCampaignAt: Date.now() + 90 * 86_400_000,
    status: "active",
    expiryEnforcement: "lazy-on-api-access",
    overdueDecisionPolicy: "blocked",
    itemCount: 1,
    counts: { pending: 1, attested: 0, revoked: 0, removed: 0 },
    ...overrides,
  };
}

function recertificationItem(overrides: Partial<RecertificationItem> = {}): RecertificationItem {
  return {
    id: "recert-item-globex",
    principalId: globexUser.id,
    capsuleId: "vendor-globex",
    personaId: "consumer",
    assignmentId: "assignment.globex.consumer",
    status: "pending",
    eligibleReviewerRoles: ["data-owner", "governance-admin"],
    createdAt: Date.now() - 86_400_000,
    ...overrides,
  };
}

const sodViolation: SodViolation = {
  ruleId: "sod.finance.operate",
  ruleVersion: 1,
  title: "Finance custody conflicts with pipeline operation",
  severity: "critical",
  rationale: "One identity cannot both control finance data and operate its ingestion path.",
  remediation: "Separate finance access and pipeline operation across different principals.",
  principalId: businessUser.id,
  evidence: {
    left: { source: "standing", principalId: businessUser.id, purpose: "operations", actions: ["operate"], products: ["transactions"], ceiling: "internal", capsuleId: "ops" },
    right: { source: "candidate", principalId: businessUser.id, purpose: "finance", actions: ["view"], products: ["transactions"], ceiling: "internal" },
  },
};

function jitGrant(overrides: Partial<JitGrant> = {}): JitGrant {
  return {
    id: "jit-example",
    requesterId: businessUser.id,
    principalId: businessUser.id,
    datasetId: "s4_vendor",
    capsuleId: "vendor-acme",
    personaId: "consumer",
    contractId: "jit.acme.vendor-diagnostic",
    purpose: "vendor-performance",
    actions: ["view"],
    denyFields: ["bank_account", "tax_id"],
    allowedFields: ["vendor_id", "legal_name"],
    predicate: { op: "fromCapsuleAttr", field: "vendor_id", attr: "vendor_set" },
    capsuleAttrs: { vendor_set: ["V1001", "V1002"] },
    classificationMax: "confidential",
    policyVersion: "jit-policy-example",
    requestContext: {
      justification: "Investigate vendor synchronization",
      requestedTtlMs: 900_000,
      ticket: "INC-10482",
    },
    status: "pending",
    createdAt: Date.now(),
    ...overrides,
  };
}

function compiledPolicy(capsuleId: string, overrides: Partial<CompiledPolicy> = {}): CompiledPolicy {
  return {
    capsuleId,
    policyVersion: `cca-${capsuleId}-version`,
    policyHash: `${capsuleId.replaceAll("-", "")}0123456789abcdef0123456789abcdef`,
    deploymentStatus: "blocked",
    previewOnly: true,
    assignments: [],
    capabilityGates: [],
    plan: { apply: [], revoke: [], readback: [] },
    elasticsearch: [],
    bw: [],
    bobj: { groups: [], folders: [] },
    dashboards: { spaces: [] },
    adf: { identities: [], vaultPaths: [] },
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe("production authentication", () => {
  it("reads a real JWT expiry without trusting malformed tokens", () => {
    const payload = btoa(JSON.stringify({ exp: 1_900_000_000 }));
    expect(tokenExpiresAt(`header.${payload}.signature`)).toBe(1_900_000_000_000);
    expect(tokenExpiresAt("not-a-jwt")).toBeUndefined();
  });

  it("describes boot as session restoration without asserting trust", () => {
    setToken("business-token");
    vi.spyOn(api, "me").mockImplementation(() => new Promise<Principal>(() => {}));

    render(<App />);

    const boot = screen.getByLabelText("Loading PurposeMesh control plane");
    expect(boot).toHaveTextContent("Restoring session…");
    expect(boot).not.toHaveTextContent(/trusted session/i);
  });

  it("enters the application through a seeded demo identity", async () => {
    vi.spyOn(api, "directory").mockResolvedValue({
      password: "cca-demo",
      users: [{
        username: businessUser.username,
        displayName: businessUser.displayName,
        persona: businessUser.personaLabel!,
        capsule: businessUser.capsules[0]!.label,
      }],
    });
    const login = vi.spyOn(api, "login").mockResolvedValue({ token: "business-token", principal: businessUser });
    vi.spyOn(api, "catalog").mockResolvedValue({
      ...catalog,
      capsules: [{ id: "vendor-acme", label: "Vendor ACME", purpose: "vendor-performance", active: true }],
      bindings: [{ id: "bind-wh-analytics", capsuleId: "vendor-acme", contractId: "wh.analytics" }],
    });
    const warehouseRecords = vi.spyOn(api, "warehouseRecords");

    render(<App />);
    expect(await screen.findByText("PurposeMesh")).toBeInTheDocument();
    expect(screen.getByText("Authorization workspace")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Purpose-bound access. Every governed path." })).toBeInTheDocument();
    expect(screen.getByText(/portable reference model.*SAP, BW, Elasticsearch, analytics.*modeled estate/i)).toBeInTheDocument();
    expect(screen.getByText(/seeded demo persona.*OIDC or SAML broker/i)).toBeInTheDocument();
    expect(screen.queryByText(/use your organization identity/i)).not.toBeInTheDocument();
    expect(screen.getByText("Row + field obligations")).toBeInTheDocument();
    expect(screen.getByText("Two-role approvals")).toBeInTheDocument();
    expect(screen.getByText("Fidelity-gated plans")).toBeInTheDocument();
    expect(screen.queryByText(/source fixture/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("raw-source")).not.toBeInTheDocument();
    expect(await screen.findByRole("note")).toHaveTextContent("Demo passwordcca-demo");
    fireEvent.click(await screen.findByRole("button", { name: /Emma Patel/ }));
    await waitFor(() => expect(login).toHaveBeenCalledWith("emma.acme", "cca-demo"));
    expect(await screen.findByRole("heading", { name: "Authorized data view", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("See your exact authorized slice")).toBeInTheDocument();
    expect(window.location.hash).toBe("#/data");
    expect(warehouseRecords).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("cca.token")).toBe("business-token");
    expect(localStorage.getItem("cca.token")).toBeNull();
  });

  it("switches authenticated users, clears data state, and preserves the Data route", async () => {
    vi.spyOn(api, "directory").mockResolvedValue({
      password: "cca-demo",
      users: [
        { username: businessUser.username, displayName: businessUser.displayName, persona: "Business consumer", capsule: "Vendor ACME" },
        { username: globexUser.username, displayName: globexUser.displayName, persona: "Business consumer", capsule: "Vendor Globex" },
      ],
    });
    const login = vi.spyOn(api, "login").mockImplementation(async (username) => username === globexUser.username
      ? { token: "globex-token", principal: globexUser }
      : { token: "acme-token", principal: businessUser });
    vi.spyOn(api, "catalog").mockResolvedValue({
      ...catalog,
      capsules: [{ id: "vendor-acme", label: "Vendor ACME", purpose: "vendor-performance", active: true }],
      bindings: [{ id: "bind-wh-analytics", capsuleId: "vendor-acme", contractId: "wh.analytics" }],
    });
    const warehouseRecords = vi.spyOn(api, "warehouseRecords");

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Emma Patel/ }));
    expect(await screen.findByRole("heading", { name: "Authorized data view" })).toBeInTheDocument();
    expect(screen.getAllByText("Emma Patel").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
    expect(await screen.findByRole("heading", { name: "Sign in to the control plane" })).toBeInTheDocument();
    expect(screen.queryByTestId("authorized-records")).not.toBeInTheDocument();
    expect(sessionStorage.getItem("cca.token")).toBeNull();
    expect(window.location.hash).toBe("#/data");
    fireEvent.click(await screen.findByRole("button", { name: /Finn Okafor/ }));

    expect(await screen.findByRole("heading", { name: "Authorized data view" })).toBeInTheDocument();
    expect(screen.getAllByText("Finn Okafor").length).toBeGreaterThan(0);
    expect(screen.getByText("See your exact authorized slice")).toBeInTheDocument();
    expect(warehouseRecords).not.toHaveBeenCalled();
    expect(login).toHaveBeenNthCalledWith(1, "emma.acme", "cca-demo");
    expect(login).toHaveBeenNthCalledWith(2, "finn.globex", "cca-demo");
  });

  it("replaces disabled demo login with an identity-broker integration state", async () => {
    vi.spyOn(api, "directory").mockRejectedValue(new ApiError("Not found", 404, "demo_mode_disabled"));
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Identity broker integration required" })).toBeInTheDocument();
    expect(screen.getByText("No credentials are accepted on this screen")).toBeInTheDocument();
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
    expect(screen.queryByText(/organization credentials/i)).not.toBeInTheDocument();
  });
});

describe("authorization-aware navigation", () => {
  it("keeps role assignment and governance actions out of the non-admin experience", async () => {
    setToken("business-token");
    vi.spyOn(api, "me").mockResolvedValue(businessUser);
    vi.spyOn(api, "catalog").mockResolvedValue(catalog);
    vi.spyOn(api, "dashboard").mockResolvedValue(dashboard);

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Operational data, within policy" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Primary navigation" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Role studio/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Request a role/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Capsule lifecycle/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Policy compiler/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Architecture/ })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Trusted purpose")).toHaveValue("analytics"));
    await waitFor(() =>
      expect(api.dashboard).toHaveBeenCalledWith("analytics", expect.any(AbortSignal)),
    );
  });

  it("does not treat an inherited persona as a control-plane administrator", async () => {
    setToken("legacy-custom-token");
    vi.spyOn(api, "me").mockResolvedValue({
      ...businessUser,
      personaId: "custom.legacy-admin-child",
      inherits: "admin",
      capsules: [{ id: "control-plane", label: "Control plane", purpose: "governance" }],
    });
    vi.spyOn(api, "catalog").mockResolvedValue(catalog);
    vi.spyOn(api, "dashboard").mockResolvedValue(dashboard);

    render(<App />);
    expect(await screen.findByRole("button", { name: /Request a role/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Role studio/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Access reviews/ })).not.toBeInTheDocument();
  });

  it("shows administrators a capsule-specific architecture view even when artifact totals match", async () => {
    window.history.replaceState(null, "", "/#/architecture");
    setToken("admin-token");
    vi.spyOn(api, "me").mockResolvedValue(adminUser);
    vi.spyOn(api, "catalog").mockResolvedValue({
      ...catalog,
      personas: [
        { id: "viewer", label: "Viewer", actions: ["view"], ceiling: "confidential" },
        { id: "admin", label: "Platform admin", actions: ["administer"], ceiling: "restricted" },
      ],
      capsules: [
        { id: "vendor-acme", label: "Vendor ACME", purpose: "vendor-performance", active: true, attrs: { vendor_set: ["V1001", "ACME"], tenants: ["ACME"] } },
        { id: "vendor-globex", label: "Vendor Globex", purpose: "vendor-performance", active: true, attrs: { vendor_set: ["V2001", "GLOBEX"], tenants: ["GLOBEX"] } },
        { id: "control-plane", label: "Control plane", purpose: "governance", active: true },
      ],
      datasets: [
        { id: "s4_vendor", name: "S/4 vendor master", origin: "S/4HANA", classification: "restricted", controlPlane: false, allowedFields: ["vendor_id", "legal_name"] },
        { id: "bw_vendor", name: "BW vendor analytics", origin: "S/4 replicated into BW", classification: "confidential", controlPlane: false, allowedFields: ["vendor_id", "status"] },
        { id: "es_tech", name: "Pipeline logs", origin: "Shared ES cluster", classification: "internal", controlPlane: false },
        { id: "warehouse", name: "Shared warehouse", origin: "Warehouse", classification: "confidential", controlPlane: false },
        { id: "bobj", name: "BusinessObjects", origin: "BOBJ", classification: "confidential", controlPlane: false },
      ],
      contracts: [
        { id: "vendor.acme.slice", datasetId: "bw_vendor", purpose: "vendor-performance", actions: ["view"], denyFields: ["bank_account"] },
        { id: "vendor.globex.slice", datasetId: "bw_vendor", purpose: "vendor-performance", actions: ["view"], denyFields: ["bank_account"] },
        { id: "es.ops", datasetId: "es_tech", purpose: "pipeline-reliability" },
        { id: "wh.acme", datasetId: "warehouse", purpose: "vendor-performance" },
        { id: "bobj.ops", datasetId: "bobj", purpose: "report-repair" },
      ],
      bindings: [
        { id: "bind-acme", capsuleId: "vendor-acme", contractId: "vendor.acme.slice" },
        { id: "bind-globex", capsuleId: "vendor-globex", contractId: "vendor.globex.slice" },
      ],
      memberships: [
        { principalId: "emma.acme", capsuleId: "vendor-acme", personaId: "viewer" },
        { principalId: "finn.globex", capsuleId: "vendor-globex", personaId: "viewer" },
      ],
    });
    vi.spyOn(api, "explain").mockResolvedValue({ surfaces: [
      { datasetId: "audit", datasetName: "Audit", effect: "allow", reason: "contract_allow", rowCount: 8 },
    ] });
    const compile = vi.spyOn(api, "compiler").mockImplementation(async (capsuleId) => {
      const globex = capsuleId === "vendor-globex";
      const contractId = globex ? "vendor.globex.slice" : "vendor.acme.slice";
      const vendor = globex ? "V2001" : "V1001";
      const principalId = globex ? "finn.globex" : "emma.acme";
      return compiledPolicy(capsuleId, {
        policyVersion: globex ? "cca-globex-distinct" : "cca-acme-distinct",
        policyHash: globex ? "globex0123456789abcdef0123456789abcdef" : "acme0123456789abcdef0123456789abcdef",
        assignments: [{ principalId, personaId: "viewer", kind: "human", contractIds: [contractId], actions: ["view"] }],
        capabilityGates: [{ target: "elasticsearch", contractId, datasetId: "bw_vendor", required: ["row_filter", "purpose_binding"], supported: ["row_filter"], missing: ["purpose_binding"], status: "blocked" }],
        elasticsearch: [{ name: `cca-${capsuleId}-${contractId}`, indices: [{ names: ["bw_vendor-*"], privileges: ["read"], query: { terms: { vendor_id: [vendor] } }, field_security: { grant: ["vendor_id", "status"], except: ["bank_account"] } }] }],
        bw: [{ name: `ZCCA_${capsuleId.toUpperCase().replaceAll("-", "_")}`, infoProvider: "ZVNDR_ANL", characteristics: [{ infoObject: "0VENDOR", values: [vendor] }] }],
        dashboards: { spaces: [capsuleId] },
      });
    });

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Portable policy model" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Few roles. Precise data boundaries." })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Catalog and lineage" })).toBeInTheDocument();
    expect(screen.getByText(/registered policy inventory.*not a live source-system inventory/i)).toBeInTheDocument();
    expect(screen.getByText("Registered policy metadata returned by the scoped catalog API")).toBeInTheDocument();
    expect(screen.queryByText(/source of truth/i)).not.toBeInTheDocument();
    expect(screen.getByText("S/4 vendor master")).toBeInTheDocument();
    expect(screen.getByText(/not a fabricated allow response/i)).toBeInTheDocument();
    await waitFor(() => expect(compile).toHaveBeenCalledWith("vendor-acme", expect.any(AbortSignal)));
    expect(await screen.findByText("V1001")).toBeInTheDocument();
    expect(screen.getByText(/Vendor ACME · blocked/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Desired-state preview for Vendor ACME")).toHaveTextContent("emma.acme");

    fireEvent.change(screen.getByLabelText("Inspect capsule"), { target: { value: "vendor-globex" } });

    await waitFor(() => expect(compile).toHaveBeenCalledWith("vendor-globex", expect.any(AbortSignal)));
    expect(await screen.findByText("V2001")).toBeInTheDocument();
    expect(screen.queryByText("V1001")).not.toBeInTheDocument();
    expect(screen.getByText(/Vendor Globex · blocked/i)).toBeInTheDocument();
    const globexPreview = screen.getByLabelText("Desired-state preview for Vendor Globex");
    expect(globexPreview).toHaveTextContent("vendor.globex.slice");
    expect(globexPreview).toHaveTextContent("finn.globex");
    expect(globexPreview).toHaveTextContent("V2001");
    expect(globexPreview).not.toHaveTextContent("vendor-acme");
  });

  it("lets an ordinary user preview and submit a self-service role request", async () => {
    window.history.replaceState(null, "", "/#/request");
    setToken("business-token");
    vi.spyOn(api, "me").mockResolvedValue(businessUser);
    vi.spyOn(api, "catalog").mockResolvedValue(catalog);
    vi.spyOn(api, "palette").mockResolvedValue({ palette });
    vi.spyOn(api, "previewRole").mockResolvedValue({ ...dashboard, total: undefined, errors: [], sodViolations: [], sodEvaluatedPrincipalId: businessUser.id });
    const create = vi.spyOn(api, "createRoleRequest")
      .mockRejectedValueOnce(new Error("A matching request is already pending"))
      .mockResolvedValueOnce(roleRequest("pending", "role-request-1"));

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Design an access request with evidence" })).toBeInTheDocument();
    expect(screen.getByLabelText("Role request target")).toHaveTextContent("Emma Patel");

    fireEvent.change(screen.getByLabelText("Role name"), { target: { value: completeDraft.name } });
    fireEvent.click(await screen.findByRole("button", { name: "view" }));
    fireEvent.click(screen.getAllByRole("button", { name: "finance" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "transactions" }));
    fireEvent.click(screen.getByRole("button", { name: "NA" }));
    fireEvent.click(screen.getAllByRole("button", { name: "finance" })[1]!);
    fireEvent.click(screen.getByRole("button", { name: "generic" }));
    fireEvent.click(screen.getByRole("button", { name: "hide account" }));

    const review = await screen.findByRole("button", { name: "Review role request" });
    await waitFor(() => expect(review).toBeEnabled());
    review.focus();
    fireEvent.click(review);

    let dialog = await screen.findByRole("dialog", { name: /Submit “NA finance analyst” for Emma Patel/ });
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(review).toHaveFocus());
    fireEvent.click(review);
    dialog = await screen.findByRole("dialog", { name: /Submit “NA finance analyst” for Emma Patel/ });
    expect(dialog).toHaveTextContent("Region scope");
    expect(dialog).toHaveTextContent("Department scope");
    expect(dialog).toHaveTextContent("Sources");
    expect(dialog).not.toHaveTextContent("Visible rows change from");
    expect(dialog).toHaveTextContent("Global warehouse cardinality is intentionally withheld");
    fireEvent.click(screen.getByRole("button", { name: "Submit for two approvals" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("matching request is already pending");
    expect(screen.getByRole("dialog")).toContainElement(screen.getByText(/matching request is already pending/));

    fireEvent.click(screen.getByRole("button", { name: "Submit for two approvals" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: completeDraft.name,
      regions: ["NA"],
      departments: ["finance"],
      sources: ["generic"],
    }), businessUser.id));
    expect(await screen.findByRole("status")).toHaveTextContent("submitted for Data Owner and Governance Admin approval");
  });

  it("restores an unfinished role draft after re-authentication in the same tab", async () => {
    window.history.replaceState(null, "", "/#/request");
    setToken("business-token");
    sessionStorage.setItem("cca.role-draft.emma.acme.self", JSON.stringify(completeDraft));
    vi.spyOn(api, "me").mockResolvedValue(businessUser);
    vi.spyOn(api, "catalog").mockResolvedValue(catalog);
    vi.spyOn(api, "palette").mockResolvedValue({ palette });
    const preview = vi.spyOn(api, "previewRole").mockResolvedValue({ ...dashboard, total: undefined, errors: [], sodViolations: [], sodEvaluatedPrincipalId: businessUser.id });

    render(<App />);
    expect(await screen.findByLabelText("Role name")).toHaveValue(completeDraft.name);
    await waitFor(() => expect(preview).toHaveBeenCalledWith(completeDraft, businessUser.id, expect.any(AbortSignal)));
    expect(screen.getByRole("button", { name: "Review role request" })).toBeEnabled();
  });

  it("invalidates a stale preview and keeps assignment blocked after refresh failure", async () => {
    window.history.replaceState(null, "", "/#/roles");
    setToken("admin-token");
    vi.spyOn(api, "me").mockResolvedValue(adminUser);
    vi.spyOn(api, "catalog").mockResolvedValue(catalog);
    vi.spyOn(api, "palette").mockResolvedValue({ palette });
    vi.spyOn(api, "previewRole")
      .mockResolvedValueOnce({ ...dashboard, errors: [], sodViolations: [], sodEvaluatedPrincipalId: businessUser.id })
      .mockResolvedValueOnce({ ...dashboard, visible: 80, errors: [], sodViolations: [], sodEvaluatedPrincipalId: globexUser.id })
      .mockRejectedValueOnce(new Error("Impact service unavailable"));

    render(<App />);
    await screen.findByRole("heading", { name: "Design an access request with evidence" });
    fireEvent.change(screen.getByLabelText("Role name"), { target: { value: completeDraft.name } });
    fireEvent.click(await screen.findByRole("button", { name: "view" }));
    fireEvent.click(screen.getAllByRole("button", { name: "finance" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "transactions" }));

    const review = await screen.findByRole("button", { name: "Review role request" });
    await waitFor(() => expect(review).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Target user"), { target: { value: "finn.globex" } });
    expect(screen.getByRole("button", { name: "Refreshing impact…" })).toBeDisabled();
    expect(screen.queryByText("120", { selector: ".impact-grid b" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Review role request" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "NA" }));
    expect(screen.getByRole("button", { name: "Refreshing impact…" })).toBeDisabled();
    expect(screen.queryByText("120", { selector: ".impact-grid b" })).not.toBeInTheDocument();
    expect(await screen.findByText("Impact service unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review role request" })).toBeDisabled();
  });

  it("loads persisted JIT history for an ordinary user", async () => {
    window.history.replaceState(null, "", "/#/jit");
    setToken("business-token");
    vi.spyOn(api, "me").mockResolvedValue(businessUser);
    vi.spyOn(api, "catalog").mockResolvedValue(jitCatalog);
    const list = vi.spyOn(api, "jitList").mockResolvedValue({ grants: [jitGrant({ id: "jit-existing" })], total: 1 });

    render(<App />);
    expect(await screen.findByText("jit-existing")).toBeInTheDocument();
    expect(list).toHaveBeenCalledWith({ limit: 25 }, expect.any(AbortSignal));
    expect(screen.getByText("Requests submitted by you, including earlier sessions.")).toBeInTheDocument();
  });

  it("submits JIT with the purpose enforced by the selected capsule", async () => {
    window.history.replaceState(null, "", "/#/jit");
    setToken("business-token");
    vi.spyOn(api, "me").mockResolvedValue(businessUser);
    vi.spyOn(api, "catalog").mockResolvedValue(jitCatalog);
    vi.spyOn(api, "jitList").mockResolvedValue({ grants: [], total: 0 });
    const request = vi.spyOn(api, "jitRequest").mockResolvedValue(jitGrant({
      id: "jit-capsule-purpose",
      requestContext: { justification: "Investigate vendor synchronization", requestedTtlMs: 3_600_000 },
    }));

    render(<App />);
    expect(await screen.findByLabelText("Approved elevation profile")).toHaveValue("bind-jit-acme");
    expect(screen.getByLabelText("Selected JIT contract boundary")).toHaveTextContent("vendor_id ∈ capsule.vendor_set");
    fireEvent.change(screen.getByLabelText("Operational justification"), {
      target: { value: "Investigate vendor synchronization" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit frozen scope for approval" }));

    await waitFor(() => expect(request).toHaveBeenCalledWith({
      datasetId: "s4_vendor",
      capsuleId: "vendor-acme",
      contractId: "jit.acme.vendor-diagnostic",
      purpose: "vendor-performance",
      justification: "Investigate vendor synchronization",
      durationMs: 3_600_000,
    }));
  });

  it("keeps administrators in the independent JIT approval role", async () => {
    window.history.replaceState(null, "", "/#/jit");
    setToken("admin-token");
    vi.spyOn(api, "me").mockResolvedValue(adminUser);
    vi.spyOn(api, "jitList").mockResolvedValue({ grants: [], total: 0 });

    render(<App />);
    expect(await screen.findByRole("heading", { name: "JIT approval queue" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "New elevation request" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit frozen scope for approval" })).not.toBeInTheDocument();
    expect(screen.getByText(/independently requested elevation/i)).toBeInTheDocument();
  });

  it("lets an administrator approve a pending JIT request with its requested TTL", async () => {
    window.history.replaceState(null, "", "/#/jit");
    setToken("admin-token");
    vi.spyOn(api, "me").mockResolvedValue(adminUser);
    const pending = jitGrant({ id: "jit-pending" });
    vi.spyOn(api, "jitList").mockResolvedValue({ grants: [pending], total: 1 });
    const approve = vi.spyOn(api, "jitApprove").mockResolvedValue(jitGrant({
      ...pending,
      status: "approved",
      approverId: adminUser.id,
      expiresAt: Date.now() + 900_000,
    }));

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith("jit-pending", 900_000));
    expect(await screen.findByRole("status")).toHaveTextContent("approved with a 15 minutes TTL");
  });

  it("shows the frozen JIT boundary and lets an administrator revoke it with evidence", async () => {
    window.history.replaceState(null, "", "/#/jit");
    setToken("admin-token");
    vi.spyOn(api, "me").mockResolvedValue(adminUser);
    const approved = jitGrant({
      id: "jit-live",
      status: "approved",
      approverId: adminUser.id,
      expiresAt: Date.now() + 900_000,
    });
    vi.spyOn(api, "jitList").mockResolvedValue({ grants: [approved], total: 1 });
    const revoke = vi.spyOn(api, "jitRevoke").mockResolvedValue(jitGrant({
      ...approved,
      status: "revoked",
      revokedAt: Date.now(),
      revokedBy: adminUser.id,
      revocationReason: "Incident investigation is complete",
    }));

    render(<App />);
    expect(await screen.findByText("jit-live")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Inspect exact scope"));
    expect(screen.getByText("vendor_id ∈ capsule.vendor_set")).toBeInTheDocument();
    expect(screen.getByText("jit-policy-example")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(await screen.findByRole("alertdialog", { name: "Revoke jit-live?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke immediately" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Revocation reason"), { target: { value: "Incident investigation is complete" } });
    fireEvent.click(screen.getByRole("button", { name: "Revoke immediately" }));

    await waitFor(() => expect(revoke).toHaveBeenCalledWith("jit-live", "Incident investigation is complete"));
    expect(await screen.findByRole("status")).toHaveTextContent("revoked immediately");
    expect(screen.getByText("Revoked")).toBeInTheDocument();
  });

  it("lets an administrator deny a pending JIT request with a requester-visible reason", async () => {
    window.history.replaceState(null, "", "/#/jit");
    setToken("admin-token");
    vi.spyOn(api, "me").mockResolvedValue(adminUser);
    const pending = jitGrant({ id: "jit-deny-me" });
    vi.spyOn(api, "jitList").mockResolvedValue({ grants: [pending], total: 1 });
    const deny = vi.spyOn(api, "jitDeny").mockResolvedValue(jitGrant({
      ...pending,
      status: "denied",
      deniedAt: Date.now(),
      deniedBy: adminUser.id,
      denialReason: "Standing support path is sufficient",
    }));

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    expect(await screen.findByRole("dialog", { name: "Deny jit-deny-me?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny request" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Denial reason"), { target: { value: "Standing support path is sufficient" } });
    fireEvent.click(screen.getByRole("button", { name: "Deny request" }));

    await waitFor(() => expect(deny).toHaveBeenCalledWith("jit-deny-me", "Standing support path is sufficient"));
    expect(await screen.findByRole("status")).toHaveTextContent("no temporary access was activated");
    expect(screen.getByText("Denied")).toBeInTheDocument();
    expect(screen.getByText(/Standing support path is sufficient/)).toBeInTheDocument();
  });

  it("shows denied JIT evidence to the requester without exposing review actions", async () => {
    window.history.replaceState(null, "", "/#/jit");
    setToken("business-token");
    vi.spyOn(api, "me").mockResolvedValue(businessUser);
    vi.spyOn(api, "catalog").mockResolvedValue(jitCatalog);
    vi.spyOn(api, "jitList").mockResolvedValue({ grants: [jitGrant({
      id: "jit-denied-visible",
      status: "denied",
      deniedAt: Date.now(),
      deniedBy: adminUser.id,
      denialReason: "Use the approved operational dashboard",
    })], total: 1 });

    render(<App />);
    expect(await screen.findByText("jit-denied-visible")).toBeInTheDocument();
    expect(screen.getByText(/Use the approved operational dashboard/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deny" })).not.toBeInTheDocument();
  });

  it("loads the next cursor page of JIT evidence without replacing earlier requests", async () => {
    window.history.replaceState(null, "", "/#/jit");
    setToken("admin-token");
    vi.spyOn(api, "me").mockResolvedValue(adminUser);
    const list = vi.spyOn(api, "jitList").mockImplementation(async (input) => input?.cursor === 1
      ? { grants: [jitGrant({ id: "jit-page-2", status: "denied", denialReason: "Not approved" })], total: 2 }
      : { grants: [jitGrant({ id: "jit-page-1" })], nextCursor: 1, total: 2 });

    render(<App />);
    expect(await screen.findByText("jit-page-1")).toBeInTheDocument();
    expect(screen.getByText(/Showing 1 of 2/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("jit-page-2")).toBeInTheDocument();
    expect(screen.getByText("jit-page-1")).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith({ cursor: 1, limit: 25 });
    expect(screen.getByText("All available records loaded")).toBeInTheDocument();
  });

  it("opens Data without fetching records until the user runs the authorized view", async () => {
    window.history.replaceState(null, "", "/#/data");
    setToken("business-token");
    vi.spyOn(api, "me").mockResolvedValue(businessUser);
    vi.spyOn(api, "catalog").mockResolvedValue({
      ...catalog,
      capsules: [{ id: "vendor-acme", label: "Vendor ACME", purpose: "vendor-performance", active: true }],
      bindings: [{ id: "bind-wh-analytics", capsuleId: "vendor-acme", contractId: "wh.analytics" }],
    });
    const data = vi.spyOn(api, "warehouseRecords").mockResolvedValue({
      dataset: { id: "warehouse", name: "Unified data", origin: "Synthetic", classification: "confidential", allowedFields: ["id"] },
      purpose: "analytics",
      visible: 0,
      records: [],
      facets: { products: [], tenants: [], regions: [], departments: [], sensitivities: [], sources: [] },
      lineage: [],
      receipt: {
        subjectId: businessUser.id,
        personaId: businessUser.personaId,
        tokenPersonaId: businessUser.personaId,
        effectiveAssignments: [{ capsuleId: "vendor-acme", capsuleLabel: "Vendor ACME", personaId: "consumer", personaLabel: "Business consumer" }],
        effect: "allow",
        reason: "contract_allow",
        contractIds: ["wh.analytics"],
        capsuleIds: ["vendor-acme"],
        allowedFields: ["id"],
        denyFields: [],
        protectedFieldCount: 1,
      },
    });

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Authorized data view" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Business purpose")).toHaveValue("analytics"));
    expect(data).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Run authorized view" }));
    await waitFor(() => expect(data).toHaveBeenCalledWith({ purpose: "analytics", cursor: undefined, limit: 50 }, expect.any(AbortSignal)));
  });

  it("does not imply global cardinality or amounts when the API withholds them", async () => {
    setToken("business-token");
    vi.spyOn(api, "me").mockResolvedValue(businessUser);
    vi.spyOn(api, "catalog").mockResolvedValue(catalog);
    vi.spyOn(api, "dashboard").mockResolvedValue({
      ...dashboard,
      total: undefined,
      byProduct: [{ key: "transactions", count: 120 }],
    });
    render(<App />);

    expect(await screen.findByText("Rows visible in scope")).toBeInTheDocument();
    expect(screen.queryByText("Facts in warehouse")).not.toBeInTheDocument();
    expect(screen.queryByText("Authorized share")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Products" }));
    expect(screen.getByRole("heading", { name: "Rows by product" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Amount by product" })).not.toBeInTheDocument();
  });

  it("gives a Data Owner only the scoped governance queue and records a partial approval", async () => {
    window.history.replaceState(null, "", "/#/reviews");
    setToken("data-owner-token");
    vi.spyOn(api, "me").mockResolvedValue(dataOwnerUser);
    const pending = { ...roleRequest("pending", "owner-review-1"), principalId: globexUser.id };
    vi.spyOn(api, "roleRequests").mockResolvedValue({ requests: [pending], total: 1 });
    const approve = vi.spyOn(api, "approveRoleRequest").mockResolvedValue({
      ...pending,
      approvals: [{ reviewerId: dataOwnerUser.id, reviewerRole: "data-owner", decision: "approved", decidedAt: Date.now() }],
    });

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Access reviews" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Access reviews/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Recertification/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Architecture/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Role studio/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Capsule lifecycle/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Policy compiler/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Audit trail/ })).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    const dialog = await screen.findByRole("dialog", { name: completeDraft.name });
    expect(within(dialog).getByLabelText("0 of 2 approvals complete")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Record Data Owner approval" }));

    await waitFor(() => expect(approve).toHaveBeenCalledWith("owner-review-1"));
    expect(await screen.findByRole("status")).toHaveTextContent("Data Owner approval recorded; 1 of 2 complete. No access was applied.");
  });

  it("does not expose approval actions for decided role requests", async () => {
    window.history.replaceState(null, "", "/#/reviews");
    setToken("admin-token");
    vi.spyOn(api, "me").mockResolvedValue(adminUser);
    vi.spyOn(api, "roleRequests").mockResolvedValue({ requests: [
      roleRequest("approved", "approved-1"),
      roleRequest("pending", "pending-1"),
    ], total: 2 });

    render(<App />);
    expect(await screen.findByText("approved-1")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Review" })).toHaveLength(1);
    expect(screen.getByText("Decided")).toBeInTheDocument();
  });

  it("lets a Governance Admin complete a partially approved role request", async () => {
    window.history.replaceState(null, "", "/#/reviews");
    setToken("admin-token");
    vi.spyOn(api, "me").mockResolvedValue(adminUser);
    const pending = {
      ...roleRequest("pending", "pending-role-1"),
      approvals: [{ reviewerId: dataOwnerUser.id, reviewerRole: "data-owner" as const, decision: "approved" as const, decidedAt: Date.now() }],
    };
    vi.spyOn(api, "roleRequests").mockResolvedValue({ requests: [pending], total: 1 });
    const approve = vi.spyOn(api, "approveRoleRequest").mockResolvedValue({
      ...pending,
      status: "approved",
      reviewerId: adminUser.id,
      approvals: [...pending.approvals, { reviewerId: adminUser.id, reviewerRole: "governance-admin", decision: "approved", decidedAt: Date.now() }],
      applied: { personaId: "custom.finance", capsuleId: "role.finance", contractId: "wh.finance" },
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    const dialog = await screen.findByRole("dialog", { name: completeDraft.name });
    expect(within(dialog).getByLabelText("1 of 2 approvals complete")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Record Governance Admin approval" }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith("pending-role-1"));
    expect(await screen.findByRole("status")).toHaveTextContent("Both approvals are complete. Access was applied to role.finance");
  });

  it("renders structured SoD evidence when a review becomes unsafe before approval", async () => {
    window.history.replaceState(null, "", "/#/reviews");
    setToken("admin-token");
    vi.spyOn(api, "me").mockResolvedValue(adminUser);
    const pending = {
      ...roleRequest("pending", "stale-sod-role"),
      approvals: [{ reviewerId: dataOwnerUser.id, reviewerRole: "data-owner" as const, decision: "approved" as const, decidedAt: Date.now() }],
    };
    vi.spyOn(api, "roleRequests").mockResolvedValue({ requests: [pending], total: 1 });
    vi.spyOn(api, "approveRoleRequest").mockRejectedValue(new ApiError(
      "separation-of-duties policy blocked this approval",
      409,
      "sod_policy_violation",
      { violations: [sodViolation] },
    ));

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    const dialog = await screen.findByRole("dialog", { name: completeDraft.name });
    fireEvent.click(within(dialog).getByRole("button", { name: "Record Governance Admin approval" }));
    const finding = await within(dialog).findByRole("alert", { name: "Approval separation of duties findings" });
    expect(finding).toHaveTextContent(sodViolation.title);
    expect(finding).toHaveTextContent(sodViolation.remediation);
    expect(within(dialog).getByRole("button", { name: "Record Governance Admin approval" })).toBeDisabled();
  });

  it("loads additional role-review history from the server cursor", async () => {
    window.history.replaceState(null, "", "/#/reviews");
    setToken("admin-token");
    vi.spyOn(api, "me").mockResolvedValue(adminUser);
    const list = vi.spyOn(api, "roleRequests").mockImplementation(async (input) => input?.cursor === 1
      ? { requests: [roleRequest("denied", "role-page-2")], total: 2 }
      : { requests: [roleRequest("pending", "role-page-1")], nextCursor: 1, total: 2 });

    render(<App />);
    expect(await screen.findByText("role-page-1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("role-page-2")).toBeInTheDocument();
    expect(screen.getByText("role-page-1")).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith({ cursor: 1, limit: 25 });
    expect(screen.getByText("All available records loaded")).toBeInTheDocument();
  });

  it("lets a Data Owner attest eligible standing access with audit-linked evidence", async () => {
    window.history.replaceState(null, "", "/#/recertifications");
    setToken("data-owner-token");
    vi.spyOn(api, "me").mockResolvedValue(dataOwnerUser);
    const campaign = recertificationCampaign();
    const item = recertificationItem();
    const decidedItem = recertificationItem({
      status: "attested",
      decidedAt: Date.now(),
      decidedBy: dataOwnerUser.id,
      reviewerRole: "data-owner",
      reason: "Still required for quarterly vendor reconciliation",
      evidence: { auditSeq: 51, auditHash: "hash-attest-51", membershipFingerprint: "fingerprint-51" },
    });
    const completed = recertificationCampaign({ status: "completed", counts: { pending: 0, attested: 1, revoked: 0, removed: 0 } });
    vi.spyOn(api, "recertifications").mockResolvedValue({ campaigns: [campaign], total: 1 });
    vi.spyOn(api, "recertificationItems").mockResolvedValue({ campaign, items: [item], total: 1 });
    vi.spyOn(api, "recertificationEvidence")
      .mockResolvedValueOnce({ campaign, decisions: [], auditChainValid: true })
      .mockResolvedValueOnce({ campaign: completed, decisions: [{
        itemId: item.id,
        principalId: item.principalId,
        capsuleId: item.capsuleId,
        personaId: item.personaId,
        assignmentId: item.assignmentId,
        status: "attested",
        decidedAt: decidedItem.decidedAt!,
        decidedBy: dataOwnerUser.id,
        reviewerRole: "data-owner",
        reason: decidedItem.reason!,
        evidence: decidedItem.evidence!,
      }], auditChainValid: true });
    const decide = vi.spyOn(api, "decideRecertification").mockResolvedValue({ campaign: completed, item: decidedItem });

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Access recertification" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create campaign" })).not.toBeInTheDocument();
    expect(screen.getByText(/Overdue campaigns stop accepting decisions but do not automatically revoke access/)).toBeInTheDocument();
    expect(await screen.findByText(/assignment\.globex\.consumer/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Attest" }));
    const dialog = await screen.findByRole("dialog", { name: "Attest finn.globex?" });
    fireEvent.change(within(dialog).getByLabelText("Evidence-based reason"), { target: { value: "Still required for quarterly vendor reconciliation" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Attest access" }));

    await waitFor(() => expect(decide).toHaveBeenCalledWith(campaign.id, item.id, "attest", "Still required for quarterly vendor reconciliation"));
    expect(await screen.findByRole("status")).toHaveTextContent("was attested with evidence");
    expect(await screen.findByText(/^#51 hash-attest-/)).toBeInTheDocument();
  });

  it("lets a Governance Admin manually renew and create recertification campaigns", async () => {
    window.history.replaceState(null, "", "/#/recertifications");
    setToken("admin-token");
    vi.spyOn(api, "me").mockResolvedValue(adminUser);
    const expired = recertificationCampaign({ id: "recert-expired", status: "expired", counts: { pending: 0, attested: 1, revoked: 0, removed: 0 } });
    const renewed = recertificationCampaign({ id: "recert-renewed", name: expired.name, previousCampaignId: expired.id });
    const created = recertificationCampaign({ id: "recert-new", name: "Quarterly access certification" });
    const activeItem = recertificationItem();
    const decidedItem = recertificationItem({ status: "attested", decidedBy: dataOwnerUser.id, decidedAt: Date.now(), reviewerRole: "data-owner", reason: "Confirmed", evidence: { auditSeq: 45, auditHash: "hash-45", membershipFingerprint: "fingerprint-45" } });
    const campaignsById = new Map([[expired.id, expired], [renewed.id, renewed], [created.id, created]]);
    vi.spyOn(api, "recertifications").mockResolvedValue({ campaigns: [expired], total: 1 });
    vi.spyOn(api, "recertificationItems").mockImplementation(async (id) => ({ campaign: campaignsById.get(id)!, items: id === expired.id ? [decidedItem] : [activeItem], total: 1 }));
    vi.spyOn(api, "recertificationEvidence").mockImplementation(async (id) => ({ campaign: campaignsById.get(id)!, decisions: [], auditChainValid: true }));
    const renew = vi.spyOn(api, "renewRecertification").mockResolvedValue({ ...renewed, items: [activeItem] });
    const create = vi.spyOn(api, "createRecertification").mockResolvedValue({ ...created, items: [activeItem] });

    render(<App />);
    expect(await screen.findByLabelText("Review cadence (days)")).toHaveValue(90);
    expect(screen.getByText(/Renewal is manual; this build has no scheduler or notification worker/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Renew campaign" }));
    await waitFor(() => expect(renew).toHaveBeenCalledWith(expired.id));
    expect(await screen.findByRole("status")).toHaveTextContent("Renewed");

    fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: "Quarterly access certification",
      cadenceDays: 90,
    })));
  });

  it("renders the API audit detail object as inspectable evidence", async () => {
    window.history.replaceState(null, "", "/#/audit");
    setToken("admin-token");
    vi.spyOn(api, "me").mockResolvedValue(adminUser);
    vi.spyOn(api, "audit").mockResolvedValue({ events: [{
      seq: 12,
      at: Date.now(),
      type: "role.request.approve",
      actorId: adminUser.id,
      detail: { requestId: "role-request-123", principalId: businessUser.id },
      prevHash: "previous-hash",
      hash: "current-hash-value",
    }], total: 1 });

    render(<App />);
    expect(await screen.findByText("Role Request Approve")).toBeInTheDocument();
    expect(screen.getByText(/role-request-123/)).toBeInTheDocument();
    expect(screen.getByText(/emma.acme/)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Search actor/), { target: { value: "role-request-123" } });
    expect(screen.getByText("Role Request Approve")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Search actor/), { target: { value: "missing-evidence-id" } });
    expect(screen.getByRole("heading", { name: "No matching evidence" })).toBeInTheDocument();
  });

  it("loads additional audit evidence and reports the server total", async () => {
    window.history.replaceState(null, "", "/#/audit");
    setToken("admin-token");
    vi.spyOn(api, "me").mockResolvedValue(adminUser);
    const event = (seq: number, type: string) => ({ seq, at: Date.now(), type, actorId: adminUser.id, hash: `hash-${seq}` });
    const list = vi.spyOn(api, "audit").mockImplementation(async (input) => input?.cursor === 1
      ? { events: [event(1, "session.login")], total: 2 }
      : { events: [event(2, "role.request.approve")], nextCursor: 1, total: 2 });

    render(<App />);
    expect(await screen.findByText("Role Request Approve")).toBeInTheDocument();
    expect(screen.getByText("1 of 2 loaded")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("Session Login")).toBeInTheDocument();
    expect(screen.getByText("Role Request Approve")).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith({ cursor: 1, limit: 25 });
    expect(screen.getByText("2 of 2 loaded")).toBeInTheDocument();
  });

  it("hides the destructive demo reset when the API disables it", async () => {
    window.history.replaceState(null, "", "/#/capsules");
    setToken("admin-token");
    vi.spyOn(api, "me").mockResolvedValue(adminUser);
    vi.spyOn(api, "catalog").mockResolvedValue({ ...catalog, features: { demoReset: false } });

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Capsule lifecycle" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Reset demo" })).not.toBeInTheDocument());
  });

  it("reviews and executes capsule offboarding through the lifecycle API", async () => {
    window.history.replaceState(null, "", "/#/capsules");
    setToken("admin-token");
    vi.spyOn(api, "me").mockResolvedValue(adminUser);
    vi.spyOn(api, "catalog").mockResolvedValue({
      ...catalog,
      features: { demoReset: false },
      capsules: [
        { id: "control-plane", label: "Control plane", purpose: "governance", active: true },
        { id: "vendor-acme", label: "Vendor ACME", purpose: "vendor-performance", active: true },
      ],
      memberships: [{ principalId: businessUser.id, capsuleId: "vendor-acme" }],
    });
    const offboard = vi.spyOn(api, "offboard").mockResolvedValue({
      removedMembers: [businessUser.id],
      removedBindings: [],
      expiredJit: [],
      cascaded: ["vendor-acme"],
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Review offboarding" }));
    expect(await screen.findByRole("alertdialog", { name: "Offboard Vendor ACME?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Offboard 1 capsule" }));
    await waitFor(() => expect(offboard).toHaveBeenCalledWith("vendor-acme", false));
    expect(await screen.findByRole("status")).toHaveTextContent("removed 1 membership");
  });

  it("previews and executes a recursive capsule offboarding blast radius", async () => {
    window.history.replaceState(null, "", "/#/capsules");
    setToken("admin-token");
    vi.spyOn(api, "me").mockResolvedValue(adminUser);
    vi.spyOn(api, "catalog").mockResolvedValue({
      ...catalog,
      features: { demoReset: false },
      capsules: [
        { id: "control-plane", label: "Control plane", purpose: "governance", active: true },
        { id: "vendor-root", label: "Vendor root", purpose: "vendor-performance", active: true },
        { id: "vendor-child", label: "Child team", purpose: "vendor-performance", active: true, parentId: "vendor-root" },
        { id: "vendor-grandchild", label: "Grandchild team", purpose: "vendor-performance", active: true, parentId: "vendor-child" },
      ],
      bindings: [
        { id: "bind-root", capsuleId: "vendor-root", contractId: "wh.analytics" },
        { id: "bind-child", capsuleId: "vendor-child", contractId: "wh.analytics" },
        { id: "bind-grandchild", capsuleId: "vendor-grandchild", contractId: "wh.analytics" },
      ],
      memberships: [
        { principalId: businessUser.id, capsuleId: "vendor-root" },
        { principalId: globexUser.id, capsuleId: "vendor-child" },
        { principalId: businessUser.id, capsuleId: "vendor-grandchild" },
      ],
    });
    const offboard = vi.spyOn(api, "offboard").mockResolvedValue({
      removedMembers: [businessUser.id, globexUser.id],
      removedBindings: ["bind-root", "bind-child", "bind-grandchild"],
      expiredJit: ["jit-active"],
      cascaded: ["vendor-root", "vendor-child", "vendor-grandchild"],
    });

    render(<App />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Review offboarding" }))[0]!);
    const dialog = await screen.findByRole("alertdialog", { name: "Offboard Vendor root?" });
    expect(within(dialog).getByText(/does not claim that SAP, Elasticsearch, BI/i)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Offboard 1 capsule" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Include 2 descendant capsules/ }));
    expect(within(dialog).getByRole("button", { name: "Offboard 3 capsules" })).toBeInTheDocument();
    expect(within(dialog).getByText("Membership records").parentElement).toHaveTextContent("3");
    expect(within(dialog).getByText("Unique people").parentElement).toHaveTextContent("2");
    fireEvent.click(within(dialog).getByRole("button", { name: "Offboard 3 capsules" }));

    await waitFor(() => expect(offboard).toHaveBeenCalledWith("vendor-root", true));
    expect(await screen.findByRole("status")).toHaveTextContent("Local desired state updated for 3 capsules");
  });

  it("compiles the first active capsule that has a contract binding", async () => {
    window.history.replaceState(null, "", "/#/compiler");
    setToken("admin-token");
    vi.spyOn(api, "me").mockResolvedValue(adminUser);
    vi.spyOn(api, "catalog").mockResolvedValue({
      ...catalog,
      capsules: [
        { id: "control-plane", label: "Control plane", purpose: "governance", active: true },
        { id: "vendor-acme", label: "Vendor ACME", purpose: "vendor-performance", active: true },
      ],
      bindings: [{ id: "bind-vendor", capsuleId: "vendor-acme", contractId: "vendor.acme.slice" }],
    });
    const compiler = vi.spyOn(api, "compiler").mockResolvedValue(compiledPolicy("vendor-acme", {
      deploymentStatus: "deployable",
      previewOnly: false,
    }));

    render(<App />);
    await waitFor(() => expect(compiler).toHaveBeenCalledWith("vendor-acme", expect.any(AbortSignal)));
    expect(await screen.findByText("Compilation successful")).toBeInTheDocument();
  });

  it("contains mobile navigation focus and restores it when closed", async () => {
    setToken("business-token");
    vi.spyOn(api, "me").mockResolvedValue(businessUser);
    vi.spyOn(api, "catalog").mockResolvedValue(catalog);
    vi.spyOn(api, "dashboard").mockResolvedValue(dashboard);
    render(<App />);
    await screen.findByRole("heading", { name: "Operational data, within policy" });

    const shell = document.querySelector(".shell")!;
    expect(shell.firstElementChild).toHaveTextContent("Skip to content");
    const hash = window.location.hash;
    fireEvent.click(shell.firstElementChild!);
    expect(document.querySelector("main")).toHaveFocus();
    expect(window.location.hash).toBe(hash);
    const open = screen.getByRole("button", { name: "Open navigation" });
    open.focus();
    fireEvent.click(open);
    await waitFor(() => expect(screen.getByRole("button", { name: "Close navigation" })).toHaveFocus());
    expect(document.querySelector("main")).toHaveAttribute("inert");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(open).toHaveFocus());
    expect(document.querySelector("main")).not.toHaveAttribute("inert");
  });

  it("retries a failed dashboard load and clears the stale error", async () => {
    setToken("business-token");
    vi.spyOn(api, "me").mockResolvedValue(businessUser);
    vi.spyOn(api, "catalog").mockResolvedValue(catalog);
    const load = vi.spyOn(api, "dashboard")
      .mockRejectedValueOnce(new Error("Dashboard service unavailable"))
      .mockResolvedValueOnce(dashboard);
    render(<App />);

    expect(await screen.findByText("Dashboard service unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Rows visible to you")).toBeInTheDocument();
    expect(screen.queryByText("Dashboard service unavailable")).not.toBeInTheDocument();
  });

  it("retries failed role metadata without reloading the application", async () => {
    window.history.replaceState(null, "", "/#/roles");
    setToken("admin-token");
    vi.spyOn(api, "me").mockResolvedValue(adminUser);
    const loadCatalog = vi.spyOn(api, "catalog")
      .mockRejectedValueOnce(new Error("Policy catalog unavailable"))
      .mockResolvedValueOnce(catalog);
    vi.spyOn(api, "palette").mockResolvedValue({ palette });
    render(<App />);

    expect(await screen.findByText("Policy catalog unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(loadCatalog).toHaveBeenCalledTimes(2));
    expect(await screen.findByLabelText("Target user")).toBeInTheDocument();
    expect(screen.queryByText("Policy catalog unavailable")).not.toBeInTheDocument();
  });

  it("exposes the governed role studio to administrators with labelled controls", async () => {
    window.history.replaceState(null, "", "/#/roles");
    setToken("admin-token");
    vi.spyOn(api, "me").mockResolvedValue(adminUser);
    vi.spyOn(api, "dashboard").mockResolvedValue(dashboard);
    vi.spyOn(api, "palette").mockResolvedValue({ palette });
    vi.spyOn(api, "catalog").mockResolvedValue(catalog);

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Design an access request with evidence" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Role studio" })).toBeInTheDocument();
    expect(screen.getByLabelText("Access requirement")).toBeInTheDocument();
    expect(screen.getByLabelText("Role name")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Target user")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "view" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Review role request" })).toBeDisabled();
  });

  it("submits an administrator-authored role as a frozen request for an explicit target", async () => {
    window.history.replaceState(null, "", "/#/roles");
    setToken("admin-token");
    sessionStorage.setItem("cca.role-draft.hugo.admin.governed", JSON.stringify(completeDraft));
    vi.spyOn(api, "me").mockResolvedValue(adminUser);
    vi.spyOn(api, "catalog").mockResolvedValue(catalog);
    vi.spyOn(api, "palette").mockResolvedValue({ palette });
    const preview = vi.spyOn(api, "previewRole").mockResolvedValue({ ...dashboard, errors: [], sodViolations: [], sodEvaluatedPrincipalId: businessUser.id });
    const create = vi.spyOn(api, "createRoleRequest").mockResolvedValue({ ...roleRequest("pending", "admin-authored-request"), requesterId: adminUser.id });

    render(<App />);
    const target = await screen.findByRole("combobox", { name: "Target user" });
    await waitFor(() => expect(target).toHaveValue(businessUser.id));
    await waitFor(() => expect(preview).toHaveBeenCalledWith(completeDraft, businessUser.id, expect.any(AbortSignal)));
    const review = screen.getByRole("button", { name: "Review role request" });
    await waitFor(() => expect(review).toBeEnabled());
    const boundary = screen.getByLabelText("Generated policy boundary");
    await waitFor(() => expect(within(boundary).getByText(/^scope\.[0-9a-f]{16}$/)).toBeInTheDocument());
    expect(boundary.querySelector("select")).toBeNull();

    fireEvent.click(review);
    const dialog = await screen.findByRole("dialog", { name: /Submit “NA finance analyst” for Emma Patel/ });
    expect(dialog).toHaveTextContent("No persona, capsule, contract, or membership is created until both approvals are recorded");
    fireEvent.click(within(dialog).getByRole("button", { name: "Submit for two approvals" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith(completeDraft, businessUser.id));
    expect(await screen.findByRole("status")).toHaveTextContent("No access changed");
  });

  it("shows target-aware SoD evidence and blocks a conflicting role request", async () => {
    window.history.replaceState(null, "", "/#/roles");
    setToken("admin-token");
    sessionStorage.setItem("cca.role-draft.hugo.admin.governed", JSON.stringify(completeDraft));
    vi.spyOn(api, "me").mockResolvedValue(adminUser);
    vi.spyOn(api, "catalog").mockResolvedValue(catalog);
    vi.spyOn(api, "palette").mockResolvedValue({ palette });
    const preview = vi.spyOn(api, "previewRole").mockResolvedValue({
      ...dashboard,
      errors: [],
      sodViolations: [sodViolation],
      sodEvaluatedPrincipalId: businessUser.id,
    });

    render(<App />);
    const target = await screen.findByRole("combobox", { name: "Target user" });
    await waitFor(() => expect(target).toHaveValue(businessUser.id));
    await waitFor(() => expect(preview).toHaveBeenCalledWith(completeDraft, businessUser.id, expect.any(AbortSignal)));
    expect(await screen.findByRole("alert", { name: "Separation of duties findings" })).toHaveTextContent("Finance custody conflicts with pipeline operation");
    expect(screen.getByText("Separate finance access and pipeline operation across different principals.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review role request" })).toBeDisabled();
  });

  it("keeps an incomplete policy draft local instead of sending a schema-invalid preview", async () => {
    window.history.replaceState(null, "", "/#/roles");
    setToken("admin-token");
    vi.spyOn(api, "me").mockResolvedValue(adminUser);
    vi.spyOn(api, "catalog").mockResolvedValue(catalog);
    vi.spyOn(api, "palette").mockResolvedValue({
      palette: { ...palette, verbs: [...palette.verbs, { id: "operate", label: "operate", group: "verb" }] },
    });
    const preview = vi.spyOn(api, "previewRole").mockResolvedValue({ ...dashboard, errors: [], sodViolations: [], sodEvaluatedPrincipalId: businessUser.id });

    render(<App />);
    await screen.findByLabelText("Target user");
    fireEvent.click(await screen.findByRole("button", { name: "operate" }));
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 550)); });

    expect(preview).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Impact preview pending" })).toBeInTheDocument();
    expect(screen.queryByText("request validation failed")).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "finance" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "transactions" }));
    await waitFor(() => expect(preview).toHaveBeenCalledWith(expect.objectContaining({
      name: "Preview role",
      verbs: ["operate"],
      purpose: "finance",
      products: ["transactions"],
    }), businessUser.id, expect.any(AbortSignal)));
    expect(screen.queryByText("request validation failed")).not.toBeInTheDocument();
  });

  it("keeps unsupported generated controls visible and removable", async () => {
    window.history.replaceState(null, "", "/#/roles");
    setToken("admin-token");
    vi.spyOn(api, "me").mockResolvedValue(adminUser);
    vi.spyOn(api, "catalog").mockResolvedValue(catalog);
    vi.spyOn(api, "palette").mockResolvedValue({ palette });
    vi.spyOn(api, "generateFromAsk").mockResolvedValue({
      ask: "Rotate finance credentials",
      draft: { ...completeDraft, verbs: ["view", "rotate"] },
      rationale: ["verb rotate — secrets / credentials"],
      preview: dashboard,
      errors: ["unknown verb"],
      sodViolations: [],
    });
    vi.spyOn(api, "previewRole").mockResolvedValue({ ...dashboard, errors: [], sodViolations: [], sodEvaluatedPrincipalId: businessUser.id });

    render(<App />);
    fireEvent.change(await screen.findByLabelText("Access requirement"), {
      target: { value: "Rotate finance credentials" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate a least-privilege draft" }));

    const unsupported = await screen.findByRole("button", {
      name: "Remove Unsupported: rotate from Permitted actions",
    });
    expect(unsupported).toBeInTheDocument();
    fireEvent.click(unsupported);
    await waitFor(() => expect(screen.queryByRole("button", {
      name: "Remove Unsupported: rotate from Permitted actions",
    })).not.toBeInTheDocument());
  });

  it("persists navigation in the URL hash", async () => {
    setToken("business-token");
    vi.spyOn(api, "me").mockResolvedValue(businessUser);
    vi.spyOn(api, "catalog").mockResolvedValue(catalog);
    vi.spyOn(api, "dashboard").mockResolvedValue(dashboard);
    vi.spyOn(api, "explain").mockResolvedValue({ surfaces: [] });
    render(<App />);
    await screen.findByRole("heading", { name: "Operational data, within policy" });

    fireEvent.click(screen.getByRole("button", { name: /Effective access/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/surfaces"));
    expect(await screen.findByRole("heading", { name: "Effective access" })).toBeInTheDocument();
  });
});

describe("decision labels", () => {
  it("distinguishes allow, jit, and deny reasons", () => {
    expect(decisionLabel("allow", "contract_allow")).toBe("Allow");
    expect(decisionLabel("allow", "jit_allow")).toBe("JIT allow");
    expect(decisionLabel("deny", "no_contract_binding")).toBe("Deny · no contract binding");
  });
});

describe("vendor isolation helper", () => {
  it("extracts vendor ids from projected rows", () => {
    expect(visibleVendorIds([
      { attrs: { vendor_id: "V2001" } },
      { attrs: { vendor_id: "V1001" } },
    ])).toEqual(["V1001", "V2001"]);
  });
});

describe("RecordTable", () => {
  it("renders projected fields and an accessible empty state", () => {
    const { rerender } = render(
      <RecordTable rows={[{
        id: "bw-1",
        datasetId: "bw_vendor",
        classification: "confidential",
        attrs: { vendor_id: "V1001", vendor_name: "ACME Logistics" },
        contractId: "vendor.acme.slice",
        capsuleId: "vendor-acme",
      }]} />,
    );
    expect(screen.getByText("ACME Logistics")).toBeInTheDocument();
    expect(screen.getByText("Policy-filtered data records", { selector: "caption" })).toBeInTheDocument();
    expect(screen.queryByText("Globex Mining")).not.toBeInTheDocument();
    rerender(<RecordTable rows={[]} />);
    expect(screen.getByRole("heading", { name: "No visible records" })).toBeInTheDocument();
    expect(screen.getByText(/PDP denied/)).toBeInTheDocument();
  });
});

describe("role studio composer", () => {
  it("requires a product scope for operate-only drafts", () => {
    const draft = emptyDraft();
    draft.name = "Scoped operator";
    draft.purpose = "operations";
    draft.verbs = ["operate"];
    expect(validateDraft(draft)).toContain("Select at least one data product for the requested actions.");
  });

  it("builds and validates a custom role from policy tokens", () => {
    let draft = emptyDraft();
    expect(validateDraft(draft)).toHaveLength(3);
    draft = applyToken(draft, { id: "view", label: "view", group: "verb" });
    draft = applyToken(draft, { id: "finance", label: "finance", group: "purpose" });
    draft = applyToken(draft, { id: "confidential", label: "confidential", group: "ceiling" });
    draft = applyToken(draft, { id: "transactions", label: "transactions", group: "product" });
    draft = applyToken(draft, { id: "NA", label: "NA", group: "region" });
    draft = applyToken(draft, { id: "generic", label: "generic", group: "source" });
    draft = applyToken(draft, { id: "account_number", label: "hide account", group: "mask" });
    draft.name = "NA finance analyst";
    expect(validateDraft(draft)).toEqual([]);
    expect(draft.products).toEqual(["transactions"]);
    expect(draft.regions).toEqual(["NA"]);
    expect(draft.sources).toEqual(["generic"]);
    expect(draft.denyFields).toEqual(["account_number"]);
  });

  it("formats warehouse counts", () => {
    expect(formatCount(1_000_000).replace(/\D/g, "")).toBe("1000000");
  });
});
