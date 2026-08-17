import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  api,
  ApiError,
  type Catalog,
  type DashboardPayload,
  type Principal,
  type RoleDraft,
  type RolePalette,
  type SodViolation,
} from "./api";
import { BarChart, Sparkline } from "./Charts";
import { useModalFocus } from "./focus";
import { Icon } from "./Icons";
import { RoleStudio } from "./RoleStudio";
import { draftReadyForPreview, emptyDraft, formatCount, validateDraft } from "./roleDraft";

type DashView = "overview" | "table" | "regions" | "products" | "timeline";

const DASH_TABS: ReadonlyArray<readonly [DashView, string]> = [
  ["overview", "Overview"],
  ["products", "Products"],
  ["regions", "Regions"],
  ["timeline", "Timeline"],
  ["table", "Records"],
];

export function Dashboard({
  principal,
  variant = "overview",
  requestMode = "governed",
  onError,
  onSuccess,
}: {
  principal: Principal;
  variant?: "overview" | "role-studio";
  requestMode?: "governed" | "self";
  onError: (value: string | null) => void;
  onSuccess: (message: string) => void;
}) {
  const [purpose, setPurpose] = useState("");
  const [live, setLive] = useState<DashboardPayload | null>(null);
  const [preview, setPreview] = useState<DashboardPayload | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const draftStorageKey = `cca.role-draft.${principal.id}.${requestMode}`;
  const [draft, setDraft] = useState<RoleDraft>(() =>
    variant === "role-studio" ? readDraft(draftStorageKey) : emptyDraft()
  );
  const [palette, setPalette] = useState<RolePalette | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [view, setView] = useState<DashView>("overview");
  const [loading, setLoading] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [rationale, setRationale] = useState<string[]>([]);
  const [remoteErrors, setRemoteErrors] = useState<string[]>([]);
  const [sodViolations, setSodViolations] = useState<SodViolation[]>([]);
  const [reviewTarget, setReviewTarget] = useState<string | null>(null);
  const [roleTarget, setRoleTarget] = useState(requestMode === "self" ? principal.id : "");
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [metadataRetry, setMetadataRetry] = useState(0);
  const [dashboardRetry, setDashboardRetry] = useState(0);
  const [previewRetry, setPreviewRetry] = useState(0);
  const previewSequence = useRef(0);
  const managedCapsuleId = useManagedCapsuleId(draft);

  useEffect(() => {
    if (variant !== "role-studio") return;
    sessionStorage.setItem(draftStorageKey, JSON.stringify(draft));
  }, [draft, draftStorageKey, variant]);

  const purposes = useMemo(() => {
    if (!catalog) return [];
    const contractPurposes = catalog?.contracts
      .filter((contract) => contract.datasetId === "warehouse")
      .map((contract) => contract.purpose) ?? [];
    const capsulePurposes = principal.capsules.map((capsule) => capsule.purpose).filter(Boolean);
    return [...new Set(contractPurposes.length ? contractPurposes : capsulePurposes)];
  }, [catalog, principal.capsules]);

  useEffect(() => {
    if (!purposes.includes(purpose)) setPurpose(purposes[0] ?? "");
  }, [purpose, purposes]);

  useEffect(() => {
    const controller = new AbortController();
    setMetadataError(null);
    onError(null);
    const tasks: Promise<unknown>[] = [api.catalog(controller.signal).then(setCatalog)];
    if (variant === "role-studio") {
      tasks.push(api.palette(controller.signal).then((result) => setPalette(result.palette)));
    }
    Promise.all(tasks)
      .then(() => {
        setMetadataError(null);
        onError(null);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setMetadataError(error instanceof Error ? error.message : "Unable to load access metadata");
      });
    return () => controller.abort();
  }, [metadataRetry, onError, principal.id, principal.personaId, variant]);

  useEffect(() => {
    if (variant !== "overview") {
      setLoading(false);
      setLive(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setLive(null);
    setDashboardError(null);
    onError(null);
    if (!purpose) {
      setLoading(false);
      return () => controller.abort();
    }
    api.dashboard(purpose, controller.signal)
      .then((result) => {
        setLive(result);
        setDashboardError(null);
        onError(null);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setDashboardError(error instanceof Error ? error.message : "Unable to load workspace");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [dashboardRetry, onError, principal.id, principal.personaId, purpose, variant]);

  useEffect(() => {
    setPreview(null);
    setPreviewKey(null);
    setPreviewError(null);
    setRemoteErrors([]);
    setSodViolations([]);
    if (variant !== "role-studio" || !roleTarget || !draftReadyForPreview(draft)) {
      setPreview(null);
      setPreviewing(false);
      return;
    }
    const controller = new AbortController();
    const sequence = ++previewSequence.current;
    setPreviewing(true);
    const handle = window.setTimeout(() => {
      api.previewRole({ ...draft, name: draft.name.trim() || "Preview role" }, roleTarget, controller.signal)
        .then((result) => {
          if (sequence !== previewSequence.current) return;
          setPreview(result);
          setPreviewKey(rolePreviewKey(draft, roleTarget));
          setPreviewError(null);
          setRemoteErrors(result.errors ?? []);
          setSodViolations(result.sodViolations ?? []);
        })
        .catch((error) => {
          if (!controller.signal.aborted && sequence === previewSequence.current) {
            setPreview(null);
            setPreviewKey(null);
            setRemoteErrors([]);
            setSodViolations([]);
            setPreviewError(error instanceof Error ? error.message : "Unable to preview this policy");
          }
        })
        .finally(() => {
          if (!controller.signal.aborted && sequence === previewSequence.current) setPreviewing(false);
        });
    }, 450);
    return () => {
      window.clearTimeout(handle);
      controller.abort();
    };
  }, [draft, previewRetry, roleTarget, variant]);

  const validationErrors = useMemo(
    () => [...new Set([
      ...validateDraft(draft),
      ...remoteErrors,
      ...sodViolations.map((violation) => `${violation.ruleId}: ${violation.title}`),
    ])],
    [draft, remoteErrors, sodViolations],
  );
  const currentPreviewKey = rolePreviewKey(draft, roleTarget);
  const currentPreview = previewKey === currentPreviewKey ? preview : null;
  const previewReady = Boolean(
    currentPreview
      && previewKey === currentPreviewKey
      && !previewing
      && !previewError
      && sodViolations.length === 0
      && validationErrors.length === 0,
  );
  const data = variant === "role-studio" ? currentPreview : live;
  const totalAvailable = typeof data?.total === "number";
  const share = totalAvailable && data.total! > 0 ? data.visible / data.total! : null;
  const productAmountsAvailable = data?.byProduct.some((point) => typeof point.amount === "number") ?? false;

  async function generate(ask: string) {
    onError(null);
    setGenerating(true);
    const controller = new AbortController();
    try {
      const result = await api.generateFromAsk(ask, controller.signal);
      setDraft(result.draft);
      setRationale(result.rationale);
      setPreview(requestMode === "self" ? result.preview : null);
      setPreviewKey(requestMode === "self" && roleTarget ? rolePreviewKey(result.draft, roleTarget) : null);
      setPreviewError(null);
      setRemoteErrors(result.errors ?? []);
      setSodViolations(requestMode === "self" ? result.sodViolations ?? [] : []);
    } catch (error) {
      setPreview(null);
      setPreviewKey(null);
      setSodViolations([]);
      setPreviewError(error instanceof Error ? error.message : "Unable to generate a role draft");
    } finally {
      setGenerating(false);
    }
  }

  async function confirmApply() {
    if (!reviewTarget || !previewReady || validationErrors.length > 0) return;
    setApplyError(null);
    setApplying(true);
    try {
      const result = await api.createRoleRequest(draft, reviewTarget);
      onSuccess(`Role request ${result.id} submitted for Data Owner and Governance Admin approval. No access changed.`);
      setReviewTarget(null);
      setDraft(emptyDraft());
      sessionStorage.removeItem(draftStorageKey);
      setPreview(null);
      setPreviewKey(null);
      setRemoteErrors([]);
      setSodViolations([]);
      setRationale([]);
    } catch (error) {
      const violations = sodViolationsFromError(error);
      if (violations.length > 0) setSodViolations(violations);
      setApplyError(error instanceof Error ? error.message : "Unable to submit this role request");
    } finally {
      setApplying(false);
    }
  }

  if (variant === "role-studio") {
    return (
      <>
        <PageHeading
          eyebrow="Governance workspace"
          title="Design an access request with evidence"
          description="Compose least-privilege access, select its target, inspect its reach and generated capsule boundary, then send the frozen draft through two-persona approval."
          purpose=""
          purposes={[]}
          onPurpose={() => undefined}
        />
        {metadataError && <PanelError message={metadataError} onRetry={() => setMetadataRetry((value) => value + 1)} />}
        <div className="dash role-layout">
          <div className="dash-main">
            <div className="preview-banner" data-state={currentPreview ? "preview" : "baseline"}>
              <span><Icon name={currentPreview ? "spark" : "shield"} /> {currentPreview ? "Current draft impact" : "Configure a draft to calculate impact"}</span>
              {previewing && <span className="inline-loading">Refreshing impact…</span>}
            </div>
            {previewError && <PanelError message={previewError} onRetry={() => setPreviewRetry((value) => value + 1)} compact />}
            {sodViolations.length > 0 && <SodFindings violations={sodViolations} />}
            <ImpactSummary preview={currentPreview} draft={draft} loading={previewing} />
            {data ? (
              <div className="chart-grid">
                <BarChart title="Rows by product" points={data.byProduct} />
                <BarChart title="Rows by region" points={data.byRegion} />
                <BarChart title="Rows by department" points={data.byDepartment} />
                <BarChart title="Rows by sensitivity" points={data.bySensitivity} />
              </div>
            ) : <div className="empty-state card"><Icon name="activity" /><h2>Impact preview pending</h2><p>Complete the role controls to calculate metadata-only reach before review.</p></div>}
            <section className="safe-preview-note">
              <Icon name="lock" />
              <div>
                <b>Metadata-only preview</b>
                <p>Impact totals are calculated by the policy service. Record samples are intentionally excluded from role authoring.</p>
              </div>
            </section>
          </div>
          <RoleStudio
            draft={draft}
            palette={palette}
            catalog={catalog}
            principal={principal}
            requestMode={requestMode}
            targetId={roleTarget}
            managedCapsuleId={managedCapsuleId}
            generating={generating}
            previewing={previewing}
            previewReady={previewReady}
            rationale={rationale}
            validationErrors={validationErrors}
            onChange={setDraft}
            onTargetChange={setRoleTarget}
            onReview={(targetId) => {
              if (!previewReady) return;
              setApplyError(null);
              setReviewTarget(targetId);
            }}
            onGenerate={generate}
          />
        </div>
        {reviewTarget && (
          <ReviewDialog
            target={targetName(reviewTarget, catalog)}
            draft={draft}
            preview={currentPreview}
            applying={applying}
            error={applyError}
            managedCapsuleId={managedCapsuleId}
            sodViolations={sodViolations}
            onCancel={() => setReviewTarget(null)}
            onConfirm={confirmApply}
          />
        )}
      </>
    );
  }

  return (
    <>
      <PageHeading
        eyebrow="Access workspace"
        title="Operational data, within policy"
        description="Every metric reflects the active persona, capsule membership, business purpose, row policy, and field projection."
        purpose={purpose}
        purposes={purposes}
        onPurpose={setPurpose}
      />
      {!purpose ? (
        metadataError ? <PanelError message={metadataError} onRetry={() => setMetadataRetry((value) => value + 1)} /> : <div className="empty-state card"><Icon name="lock" /><h2>No active purpose</h2><p>This identity has no live capsule with a trusted business purpose.</p></div>
      ) : dashboardError ? <PanelError message={dashboardError} onRetry={() => setDashboardRetry((value) => value + 1)} /> : loading ? <DashboardSkeleton /> : data ? (
        <>
          <div className="statrow">
            {totalAvailable ? (
              <>
                <Stat value={formatCount(data.total!)} label="Facts in warehouse" icon="data" />
                <Stat value={formatCount(data.visible)} label="Rows visible to you" icon="shield" tone="teal" />
                <Stat value={`${((share ?? 0) * 100).toFixed(1)}%`} label="Authorized share" icon="activity" />
                <Stat value={principal.personaLabel ?? principal.personaId} label="Active persona" icon="user" />
              </>
            ) : (
              <>
                <Stat value={formatCount(data.visible)} label="Rows visible in scope" icon="shield" tone="teal" />
                <Stat value={principal.personaLabel ?? principal.personaId} label="Active persona" icon="user" />
                <Stat value={String(principal.capsules.length)} label="Active capsules" icon="activity" />
                <Stat value={humanize(principal.ceiling ?? "Not assigned")} label="Classification ceiling" icon="data" />
              </>
            )}
          </div>

          <div className="segmented" role="tablist" aria-label="Warehouse views">
            {DASH_TABS.map(([id, label], index) => (
              <button
                key={id}
                id={`warehouse-tab-${id}`}
                role="tab"
                aria-selected={view === id}
                aria-controls="warehouse-tabpanel"
                tabIndex={view === id ? 0 : -1}
                className={view === id ? "active" : ""}
                onClick={() => setView(id)}
                onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                  event.preventDefault();
                  const nextIndex = event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? DASH_TABS.length - 1
                      : (index + (event.key === "ArrowRight" ? 1 : -1) + DASH_TABS.length) % DASH_TABS.length;
                  const next = DASH_TABS[nextIndex]?.[0] ?? id;
                  setView(next);
                  requestAnimationFrame(() => document.getElementById(`warehouse-tab-${next}`)?.focus());
                }}
              >{label}</button>
            ))}
          </div>

          <div id="warehouse-tabpanel" role="tabpanel" aria-labelledby={`warehouse-tab-${view}`} tabIndex={0} className="tab-panel">
            {view === "overview" && (
              <div className="chart-grid">
                <BarChart title="Rows by product" points={data.byProduct} />
                <BarChart title="Rows by region" points={data.byRegion} />
                <BarChart title="Rows by department" points={data.byDepartment} />
                <BarChart title="Rows by sensitivity" points={data.bySensitivity} />
              </div>
            )}
            {view === "products" && <BarChart title={productAmountsAvailable ? "Amount by product" : "Rows by product"} points={data.byProduct} valueKey={productAmountsAvailable ? "amount" : "count"} />}
            {view === "regions" && <BarChart title="Rows by region" points={data.byRegion} />}
            {view === "timeline" && <Sparkline title="Authorized rows over time" points={data.byDay} />}
            {view === "table" && <FactTable rows={data.sample} />}
          </div>
        </>
      ) : (
        <div className="empty-state card"><Icon name="data" /><h2>No dashboard data</h2><p>Try another trusted purpose or refresh the workspace.</p></div>
      )}
    </>
  );
}

function PageHeading({
  eyebrow, title, description, purpose, purposes, onPurpose,
}: {
  eyebrow: string; title: string; description: string; purpose: string; purposes: string[]; onPurpose: (value: string) => void;
}) {
  const id = useId();
  return (
    <header className="page-head">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p className="lead">{description}</p>
      </div>
      {purposes.length > 0 && (
        <div className="purpose-control">
          <label htmlFor={id}>Trusted purpose</label>
          <select id={id} value={purpose} onChange={(event) => onPurpose(event.target.value)}>
            {purposes.map((item) => <option key={item} value={item}>{humanize(item)}</option>)}
          </select>
        </div>
      )}
    </header>
  );
}

function Stat({ value, label, icon, tone = "" }: { value: string; label: string; icon: "data" | "shield" | "activity" | "user"; tone?: string }) {
  return <div className={`stat ${tone}`}><div className="stat-icon"><Icon name={icon} /></div><div><b>{value}</b><span>{label}</span></div></div>;
}

function ImpactSummary({ preview, draft, loading }: { preview: DashboardPayload | null; draft: RoleDraft; loading: boolean }) {
  const totalAvailable = typeof preview?.total === "number";
  const share = totalAvailable && preview.total! > 0 ? preview.visible / preview.total! : null;
  return (
    <div className="impact-grid" aria-label="Role impact summary">
      <div><span>Draft visible rows</span><b>{preview ? formatCount(preview.visible) : "—"}</b></div>
      {totalAvailable ? (
        <>
          <div><span>Warehouse facts</span><b>{loading || !preview ? "—" : formatCount(preview.total!)}</b></div>
          <div data-tone="safe"><span>Authorized share</span><b>{preview ? `${((share ?? 0) * 100).toFixed(1)}%` : "—"}</b></div>
        </>
      ) : (
        <>
          <div><span>Data products</span><b>{draft.products.length || "—"}</b></div>
          <div><span>Classification ceiling</span><b>{humanize(draft.ceiling)}</b></div>
        </>
      )}
      <div><span>Fields protected</span><b>{draft.denyFields.length || "—"}</b></div>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="dashboard-skeleton" role="status" aria-label="Loading access dashboard">
      <div className="statrow">{[0, 1, 2, 3].map((item) => <span key={item} />)}</div>
      <div className="chart-grid"><span /><span /><span /><span /></div>
    </div>
  );
}

function FactTable({ rows }: { rows: DashboardPayload["sample"] }) {
  const keys = useMemo(() => {
    const set = new Set<string>();
    for (const row of rows) Object.entries(row).forEach(([key, value]) => { if (value !== undefined) set.add(key); });
    return [...set];
  }, [rows]);
  if (rows.length === 0) {
    return <div className="empty-state compact"><Icon name="lock" /><h2>No record samples</h2><p>The current scope is empty or this view is metadata-only.</p></div>;
  }
  return (
    <div className="table-wrap">
      <table data-testid="warehouse-rows">
        <caption>Authorized sample records</caption>
        <thead><tr>{keys.map((key) => <th key={key} scope="col">{humanize(key)}</th>)}</tr></thead>
        <tbody>{rows.map((row) => (
          <tr key={row.id}>{keys.map((key) => <td key={key}>{formatCell(key, (row as unknown as Record<string, unknown>)[key])}</td>)}</tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function ReviewDialog({
  target, draft, preview, applying, error, managedCapsuleId, sodViolations, onCancel, onConfirm,
}: {
  target: string; draft: RoleDraft; preview: DashboardPayload | null; applying: boolean; error: string | null;
  managedCapsuleId: string; sodViolations: SodViolation[]; onCancel: () => void; onConfirm: () => void;
}) {
  const titleId = useId();
  const modalRef = useModalFocus<HTMLElement>(onCancel, applying);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !applying) onCancel(); }}>
      <section ref={modalRef} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="modal-icon"><Icon name="shield" /></div>
        <div className="eyebrow">Final review</div>
        <h2 id={titleId}>Submit “{draft.name}” for {target}?</h2>
        <p className="lead">This freezes the request for independent Data Owner and Governance Admin approval. No persona, capsule, contract, or membership is created until both approvals are recorded.</p>
        <dl className="review-grid">
          <div><dt>Target user</dt><dd>{target}</dd></div>
          <div><dt>Managed capsule</dt><dd><code>{managedCapsuleId}</code></dd></div>
          <div><dt>Actions</dt><dd>{draft.verbs.join(", ")}</dd></div>
          <div><dt>Purpose</dt><dd>{humanize(draft.purpose)}</dd></div>
          <div><dt>Ceiling</dt><dd>{humanize(draft.ceiling)}</dd></div>
          <div><dt>Products</dt><dd>{draft.products.map(humanize).join(", ")}</dd></div>
          <div><dt>Tenant scope</dt><dd>{draft.tenants.join(", ") || "All tenants"}</dd></div>
          <div><dt>Region scope</dt><dd>{draft.regions.join(", ") || "All regions"}</dd></div>
          <div><dt>Department scope</dt><dd>{draft.departments.join(", ") || "All departments"}</dd></div>
          <div><dt>Sources</dt><dd>{draft.sources.map(humanize).join(", ") || "All sources"}</dd></div>
          <div><dt>Protected fields</dt><dd>{draft.denyFields.join(", ") || "None"}</dd></div>
        </dl>
        <div className="impact-callout">
          <Icon name="activity" />
          {typeof preview?.total === "number" ? (
            <span>The current draft exposes <b>{formatCount(preview.visible)}</b> of <b>{formatCount(preview.total)}</b> warehouse facts in the metadata-only preview.</span>
          ) : (
            <span>The current draft reports <b>{formatCount(preview?.visible ?? 0)}</b> visible rows within the requester’s authorized scope. Global warehouse cardinality is intentionally withheld.</span>
          )}
        </div>
        {sodViolations.length > 0 && <SodFindings violations={sodViolations} compact />}
        {error && <div className="dialog-error" role="alert"><Icon name="warning" /><span>{error}</span></div>}
        <div className="modal-actions">
          <button data-autofocus className="btn secondary" disabled={applying} onClick={onCancel}>Cancel</button>
          <button className="btn primary" disabled={applying || !preview || sodViolations.length > 0} onClick={onConfirm}>
            <Icon name="check" />{applying ? "Submitting request…" : "Submit for two approvals"}
          </button>
        </div>
      </section>
    </div>
  );
}

function targetName(id: string, catalog: Catalog | null) {
  return catalog?.principals.find((principal) => principal.id === id)?.displayName ?? id;
}

function rolePreviewKey(draft: RoleDraft, targetId: string) {
  return JSON.stringify({ draft, targetId });
}

function useManagedCapsuleId(draft: RoleDraft) {
  const scopeInput = useMemo(() => JSON.stringify({
    purpose: draft.purpose,
    attrs: {
      tenants: [...draft.tenants].sort(),
      regions: [...draft.regions].sort(),
      departments: [...draft.departments].sort(),
      products: [...draft.products].sort(),
      sources: [...draft.sources].sort(),
    },
  }), [draft.departments, draft.products, draft.purpose, draft.regions, draft.sources, draft.tenants]);
  const [capsuleId, setCapsuleId] = useState("scope.<calculating>");
  useEffect(() => {
    let active = true;
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
      setCapsuleId("scope.<finalized-by-control-plane>");
      return () => { active = false; };
    }
    setCapsuleId("scope.<calculating>");
    void subtle.digest("SHA-256", new TextEncoder().encode(scopeInput)).then((digest) => {
      if (!active) return;
      const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
      setCapsuleId(`scope.${hash.slice(0, 16)}`);
    }).catch(() => {
      if (active) setCapsuleId("scope.<finalized-by-control-plane>");
    });
    return () => { active = false; };
  }, [scopeInput]);
  return capsuleId;
}

function SodFindings({ violations, compact = false }: { violations: SodViolation[]; compact?: boolean }) {
  return <section className={`sod-findings ${compact ? "compact" : ""}`} role="alert" aria-label="Separation of duties findings"><div className="sod-findings-head"><Icon name="warning" /><div><b>Separation-of-duties policy blocked this draft</b><span>{violations.length} executable policy finding{violations.length === 1 ? "" : "s"}</span></div></div><div className="sod-finding-list">{violations.map((violation) => <article key={`${violation.ruleId}-${violation.ruleVersion}`}><header><code>{violation.ruleId}@{violation.ruleVersion}</code><span data-severity={violation.severity}>{humanize(violation.severity)}</span></header><h3>{violation.title}</h3><p>{violation.rationale}</p><dl><div><dt>Conflicting access</dt><dd>{sodFactLabel(violation.evidence.left)} + {sodFactLabel(violation.evidence.right)}</dd></div><div><dt>Remediation</dt><dd>{violation.remediation}</dd></div></dl></article>)}</div></section>;
}

function sodFactLabel(fact: SodViolation["evidence"]["left"]) {
  const capabilities = [...fact.actions.map(humanize), ...fact.products.map(humanize)];
  return `${humanize(fact.source)} ${humanize(fact.purpose)}${capabilities.length ? ` (${capabilities.join(", ")})` : ""}`;
}

function sodViolationsFromError(error: unknown): SodViolation[] {
  if (!(error instanceof ApiError) || error.code !== "sod_policy_violation") return [];
  const details = error.details && typeof error.details === "object" ? error.details as { violations?: unknown } : undefined;
  if (!Array.isArray(details?.violations)) return [];
  return details.violations.filter((item): item is SodViolation => Boolean(
    item && typeof item === "object" && typeof (item as SodViolation).ruleId === "string",
  ));
}

function readDraft(key: string): RoleDraft {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(key) ?? "null") as Record<string, unknown> | null;
    if (!parsed) return emptyDraft();
    const arrays = ["verbs", "products", "tenants", "regions", "departments", "denyFields", "sources"] as const;
    if (
      typeof parsed.name !== "string"
      || typeof parsed.purpose !== "string"
      || typeof parsed.ceiling !== "string"
      || arrays.some((field) => !Array.isArray(parsed[field]) || parsed[field].some((value) => typeof value !== "string"))
    ) return emptyDraft();
    return parsed as unknown as RoleDraft;
  } catch {
    return emptyDraft();
  }
}

function PanelError({ message, onRetry, compact = false }: { message: string; onRetry: () => void; compact?: boolean }) {
  return (
    <div className={`inline-state error ${compact ? "compact" : ""}`} role="alert">
      <Icon name="warning" />
      <div><h2>Unable to refresh this view</h2><p>{message}</p><button className="btn secondary small" onClick={onRetry}><Icon name="refresh" />Try again</button></div>
    </div>
  );
}

function humanize(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatCell(key: string, value: unknown) {
  if (value === undefined || value === null || value === "") return <span className="muted">Not available</span>;
  if (key === "amount" && typeof value === "number") {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
  }
  if ((key.endsWith("_at") || key === "occurred_at") && typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString();
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
