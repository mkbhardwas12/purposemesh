import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AuthorizedDataView } from "./DataView";
import {
  api,
  type Catalog,
  type Principal,
  type WarehouseRecordsPage,
} from "./api";

const emma: Principal = {
  id: "emma.acme",
  username: "emma.acme",
  displayName: "Emma Patel",
  personaId: "consumer",
  personaLabel: "Business consumer",
  kind: "human",
  actions: ["view"],
  ceiling: "confidential",
  capsules: [{ id: "vendor-acme", label: "Vendor ACME", purpose: "vendor-performance" }],
  assignments: [{
    capsuleId: "vendor-acme",
    capsuleLabel: "Vendor ACME",
    purpose: "vendor-performance",
    personaId: "consumer",
    personaLabel: "Business consumer",
    actions: ["view"],
    ceiling: "confidential",
  }],
};

const catalog: Catalog = {
  personas: [{ id: "consumer", label: "Business consumer", actions: ["view"], ceiling: "confidential" }],
  capsules: [{ id: "vendor-acme", label: "Vendor ACME", purpose: "vendor-performance", active: true }],
  datasets: [{ id: "warehouse", name: "Unified operational data", origin: "Synthetic pipelines", classification: "confidential", controlPlane: false }],
  contracts: [{ id: "wh.acme", datasetId: "warehouse", purpose: "analytics", allowedPersonas: ["consumer"] }],
  bindings: [{ id: "bind-wh-acme", capsuleId: "vendor-acme", contractId: "wh.acme" }],
  principals: [],
  memberships: [],
};

function page(overrides: Partial<WarehouseRecordsPage> = {}): WarehouseRecordsPage {
  return {
    dataset: {
      id: "warehouse",
      name: "Unified operational data",
      origin: "Synthetic enterprise pipelines",
      design: "Policy-filtered facts",
      classification: "confidential",
      allowedFields: ["id", "pipeline_name", "source_system", "target_system", "product", "tenant", "region", "status", "amount"],
    },
    purpose: "analytics",
    visible: 24_000,
    records: [{
      id: 101,
      pipeline_id: "s4-bw-vendor",
      pipeline_name: "S/4 Vendor → SAP BW → Unified Store",
      source_system: "SAP S/4HANA",
      target_system: "PurposeMesh Unified Data Store",
      product: "bw_vendor",
      tenant: "ACME",
      region: "NA",
      status: "open",
      amount: 1250,
    }],
    nextCursor: 101,
    facets: {
      products: [{ key: "bw_vendor", count: 12_000 }],
      tenants: [{ key: "ACME", count: 24_000 }],
      regions: [{ key: "NA", count: 8_000 }],
      departments: [{ key: "finance", count: 4_000 }],
      sensitivities: [{ key: "confidential", count: 24_000 }],
      sources: [{ key: "sap", count: 12_000 }],
    },
    lineage: [{
      pipelineId: "s4-bw-vendor",
      pipelineName: "S/4 Vendor → SAP BW → Unified Store",
      sourceSystem: "SAP S/4HANA",
      targetSystem: "PurposeMesh Unified Data Store",
      count: 12_000,
    }],
    receipt: {
      subjectId: emma.id,
      personaId: emma.personaId,
      tokenPersonaId: emma.personaId,
      effectiveAssignments: [{
        capsuleId: "vendor-acme",
        capsuleLabel: "Vendor ACME",
        personaId: "consumer",
        personaLabel: "Business consumer",
      }],
      effect: "allow",
      reason: "contract_allow",
      contractIds: ["wh.acme"],
      capsuleIds: ["vendor-acme"],
      allowedFields: ["id", "pipeline_name", "source_system", "target_system", "product", "tenant", "region", "status", "amount"],
      denyFields: [],
      protectedFieldCount: 5,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(api, "catalog").mockResolvedValue(catalog);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AuthorizedDataView", () => {
  it("waits for an explicit run, then renders only server-authorized rows and fields", async () => {
    const query = vi.spyOn(api, "warehouseRecords").mockResolvedValue(page());

    render(<AuthorizedDataView principal={emma} onSwitchAccount={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Authorized data view" })).toBeInTheDocument();
    expect(screen.getByText("See your exact authorized slice")).toBeInTheDocument();
    expect(screen.getByText(/exact rows, fields, and pipeline lineage/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Business purpose")).toHaveValue("analytics"));
    expect(query).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Run authorized view" }));

    await waitFor(() => expect(query).toHaveBeenCalledWith(
      { purpose: "analytics", cursor: undefined, limit: 50 },
      expect.any(AbortSignal),
    ));
    const records = await screen.findByTestId("authorized-records");
    expect(within(records).getByText("S/4 Vendor → SAP BW → Unified Store")).toBeInTheDocument();
    expect(within(records).getByText("ACME")).toBeInTheDocument();
    expect(within(records).queryByText(/account number/i)).not.toBeInTheDocument();
    expect(screen.getByText("Why this view is allowed")).toBeInTheDocument();
    expect(screen.getByText("Authorization receipt")).toBeInTheDocument();
    expect(screen.getAllByText("Protected fields").length).toBeGreaterThan(0);
    expect(screen.getByText("5 field names withheld by policy")).toBeInTheDocument();
    expect(screen.queryByText("Dataset total")).not.toBeInTheDocument();
  });

  it("shows global cardinality only when the authorized response includes it", async () => {
    const owner = {
      ...emma,
      id: "dana.owner",
      username: "dana.owner",
      displayName: "Dana Ortiz",
      personaId: "data-owner",
      personaLabel: "Data Owner",
      capsules: [{ id: "data-governance-owner", label: "Unified data governance", purpose: "data-governance" }],
      assignments: [{
        capsuleId: "data-governance-owner",
        capsuleLabel: "Unified data governance",
        purpose: "data-governance",
        personaId: "data-owner",
        personaLabel: "Data Owner",
        actions: ["view", "audit"],
        ceiling: "restricted",
      }],
    };
    vi.mocked(api.catalog).mockResolvedValue({
      ...catalog,
      contracts: [{ id: "wh.data-owner", datasetId: "warehouse", purpose: "data-governance", allowedPersonas: ["data-owner"] }],
      bindings: [{ id: "bind-wh-owner", capsuleId: "data-governance-owner", contractId: "wh.data-owner" }],
    });
    vi.spyOn(api, "warehouseRecords").mockResolvedValue(page({
      purpose: "data-governance",
      total: 120_000,
      visible: 120_000,
      receipt: {
        ...page().receipt,
        subjectId: owner.id,
        personaId: owner.personaId,
        tokenPersonaId: owner.personaId,
        effectiveAssignments: [{
          capsuleId: "data-governance-owner",
          capsuleLabel: "Unified data governance",
          personaId: "data-owner",
          personaLabel: "Data Owner",
        }],
        protectedFieldCount: 0,
      },
    }));
    render(<AuthorizedDataView principal={owner} onSwitchAccount={vi.fn()} />);

    await waitFor(() => expect(screen.getByLabelText("Business purpose")).toHaveValue("data-governance"));
    fireEvent.click(screen.getByRole("button", { name: "Run authorized view" }));

    const label = await screen.findByText("Dataset total");
    expect(label.closest("article")).toHaveTextContent("120");
    expect(label.closest("article")).toHaveTextContent("Visible only to Data Owner");
  });

  it("uses server cursors for pagination and renders a deny receipt without rows", async () => {
    const query = vi.spyOn(api, "warehouseRecords").mockImplementation(async (input) => {
      if (input.cursor === 101) return page({ records: [{ id: 102, pipeline_name: "ADF → Warehouse", tenant: "ACME" }], nextCursor: undefined });
      return page();
    });
    render(<AuthorizedDataView principal={emma} onSwitchAccount={vi.fn()} />);

    await waitFor(() => expect(screen.getByLabelText("Business purpose")).toHaveValue("analytics"));
    fireEvent.click(screen.getByRole("button", { name: "Run authorized view" }));
    await screen.findByTestId("authorized-records");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(query).toHaveBeenLastCalledWith(
      { purpose: "analytics", cursor: 101, limit: 50 },
      expect.any(AbortSignal),
    ));
    expect((await screen.findAllByText("ADF → Warehouse")).length).toBeGreaterThan(0);
    expect(screen.getByText("Page 2")).toBeInTheDocument();

    query.mockResolvedValueOnce(page({
      visible: 0,
      records: [],
      nextCursor: undefined,
      facets: { products: [], tenants: [], regions: [], departments: [], sensitivities: [], sources: [] },
      lineage: [],
      receipt: { ...page().receipt, effect: "deny", reason: "no_contract_binding", contractIds: [], capsuleIds: [], effectiveAssignments: [], allowedFields: [], denyFields: [], protectedFieldCount: 0 },
    }));
    fireEvent.click(screen.getByRole("button", { name: "Run authorized view" }));
    expect(await screen.findByText("No records released")).toBeInTheDocument();
    expect(screen.queryByTestId("authorized-records")).not.toBeInTheDocument();
  });

  it("uses the effective membership persona for a custom role purpose and explanation", async () => {
    const customPrincipal: Principal = {
      ...emma,
      assignments: [
        ...emma.assignments!,
        {
          capsuleId: "custom-finance-acme",
          capsuleLabel: "ACME finance slice",
          purpose: "finance",
          personaId: "custom.finance-analyst",
          personaLabel: "Regional finance analyst",
          inherits: "consumer",
          actions: ["view"],
          ceiling: "confidential",
        },
      ],
      capsules: [
        ...emma.capsules,
        { id: "custom-finance-acme", label: "ACME finance slice", purpose: "finance" },
      ],
    };
    vi.mocked(api.catalog).mockResolvedValue({
      ...catalog,
      contracts: [
        ...catalog.contracts,
        {
          id: "wh.custom-finance",
          datasetId: "warehouse",
          purpose: "finance",
          allowedPersonas: ["custom.finance-analyst"],
          actions: ["view"],
        },
      ],
      bindings: [
        ...catalog.bindings,
        { id: "bind-custom-finance", capsuleId: "custom-finance-acme", contractId: "wh.custom-finance" },
      ],
    });
    const query = vi.spyOn(api, "warehouseRecords").mockResolvedValue(page({
      purpose: "finance",
      receipt: {
        ...page().receipt,
        contractIds: ["wh.custom-finance"],
        capsuleIds: ["custom-finance-acme"],
        effectiveAssignments: [{
          capsuleId: "custom-finance-acme",
          capsuleLabel: "ACME finance slice",
          personaId: "custom.finance-analyst",
          personaLabel: "Regional finance analyst",
        }],
      },
    }));

    render(<AuthorizedDataView principal={customPrincipal} onSwitchAccount={vi.fn()} />);
    const purposeSelect = await screen.findByLabelText("Business purpose");
    await waitFor(() => expect(within(purposeSelect).getByRole("option", { name: "Finance" })).toBeInTheDocument());
    fireEvent.change(purposeSelect, { target: { value: "finance" } });
    fireEvent.click(screen.getByRole("button", { name: "Run authorized view" }));

    await waitFor(() => expect(query).toHaveBeenCalledWith(
      { purpose: "finance", cursor: undefined, limit: 50 },
      expect.any(AbortSignal),
    ));
    expect((await screen.findAllByText("Regional finance analyst")).length).toBeGreaterThan(0);
    expect(screen.getByText("custom.finance-analyst")).toBeInTheDocument();
    expect(screen.getByText("Token persona").parentElement).toHaveTextContent("Business consumer");
  });
});
