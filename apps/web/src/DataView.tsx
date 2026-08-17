import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type Catalog,
  type Principal,
  type WarehouseFacet,
  type WarehouseRecordsPage,
} from "./api";
import { Icon } from "./Icons";

const PAGE_SIZES = [25, 50, 100] as const;
const PREFERRED_COLUMNS = [
  "id",
  "pipeline_name",
  "source_system",
  "target_system",
  "product",
  "tenant",
  "region",
  "department",
  "sensitivity",
  "status",
  "title",
  "amount",
  "occurred_at",
] as const;

export function AuthorizedDataView({
  principal,
  onSwitchAccount,
}: {
  principal: Principal;
  onSwitchAccount: () => void;
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [metadataLoading, setMetadataLoading] = useState(true);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [purpose, setPurpose] = useState("");
  const [limit, setLimit] = useState<(typeof PAGE_SIZES)[number]>(50);
  const [result, setResult] = useState<WarehouseRecordsPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasRun, setHasRun] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [cursorHistory, setCursorHistory] = useState<Array<number | undefined>>([undefined]);
  const requestRef = useRef<AbortController | null>(null);

  const purposes = useMemo(() => {
    if (!catalog) return [];
    const assignments = principal.assignments ?? principal.capsules.map((capsule) => ({
      capsuleId: capsule.id,
      capsuleLabel: capsule.label,
      purpose: capsule.purpose,
      personaId: principal.personaId,
      personaLabel: principal.personaLabel ?? principal.personaId,
      inherits: principal.inherits,
      actions: principal.actions,
      ceiling: principal.ceiling ?? "none",
    }));
    const contractPurposes = catalog.contracts
      .filter((contract) => contract.datasetId === "warehouse")
      .filter((contract) => contract.actions === undefined || contract.actions.includes("view"))
      .filter((contract) => catalog.bindings.some((binding) => {
        if (binding.contractId !== contract.id) return false;
        const assignment = assignments.find((candidate) => candidate.capsuleId === binding.capsuleId);
        if (!assignment) return false;
        return !contract.allowedPersonas?.length
          || contract.allowedPersonas.includes(assignment.personaId)
          || Boolean(assignment.inherits && contract.allowedPersonas.includes(assignment.inherits));
      }))
      .map((contract) => contract.purpose);
    return [...new Set(contractPurposes)];
  }, [catalog, principal]);
  const activePurpose = purposes.includes(purpose) ? purpose : (purposes[0] ?? "");

  useEffect(() => {
    const controller = new AbortController();
    setMetadataLoading(true);
    setMetadataError(null);
    api.catalog(controller.signal)
      .then(setCatalog)
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setMetadataError(cause instanceof Error ? cause.message : "Unable to load purpose metadata");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setMetadataLoading(false);
      });
    return () => controller.abort();
  }, [principal.id]);

  useEffect(() => {
    if (!purposes.includes(purpose)) setPurpose(purposes[0] ?? "");
  }, [purpose, purposes]);

  useEffect(() => () => requestRef.current?.abort(), []);

  function clearAuthorizedState() {
    requestRef.current?.abort();
    requestRef.current = null;
    setResult(null);
    setError(null);
    setLoading(false);
    setHasRun(false);
    setPageIndex(0);
    setCursorHistory([undefined]);
  }

  async function fetchPage(cursor: number | undefined, nextPageIndex: number) {
    if (!activePurpose) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError(null);
    setResult(null);
    setHasRun(true);
    setPageIndex(nextPageIndex);
    try {
      const response = await api.warehouseRecords({ purpose: activePurpose, cursor, limit }, controller.signal);
      if (controller.signal.aborted) return;
      setResult(response);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "Unable to run the authorized data view");
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (requestRef.current === controller) requestRef.current = null;
    }
  }

  function runFirstPage() {
    setCursorHistory([undefined]);
    void fetchPage(undefined, 0);
  }

  function nextPage() {
    if (result?.nextCursor === undefined) return;
    const nextHistory = [...cursorHistory.slice(0, pageIndex + 1), result.nextCursor];
    setCursorHistory(nextHistory);
    void fetchPage(result.nextCursor, pageIndex + 1);
  }

  function previousPage() {
    if (pageIndex === 0) return;
    void fetchPage(cursorHistory[pageIndex - 1], pageIndex - 1);
  }

  function switchAccount() {
    clearAuthorizedState();
    onSwitchAccount();
  }

  const capsuleLabels = principal.capsules.map((capsule) => capsule.label).join(", ") || "No active capsule";
  const assignmentLabels = [...new Set((principal.assignments ?? []).map((assignment) => assignment.personaLabel))];

  return (
    <section className="data-page" aria-labelledby="authorized-data-title">
      <header className="page-head">
        <div>
          <div className="eyebrow">Access · Data</div>
          <h1 id="authorized-data-title">Authorized data view</h1>
          <p className="lead">Run one server-enforced query to see the rows, fields, and pipeline facts released to the signed-in identity. Nothing is loaded until you run the view.</p>
        </div>
        <div className="page-actions">
          <button className="btn secondary" onClick={switchAccount}><Icon name="signout" />Switch account</button>
        </div>
      </header>

      <section className="data-identity card" aria-label="Current identity and query purpose">
        <div className="data-identity-person">
          <span className="avatar">{initials(principal.displayName)}</span>
          <div><span>Signed in as</span><b>{principal.displayName}</b><small>{principal.username}</small></div>
        </div>
        <dl>
          <div><dt>Assigned role</dt><dd>{assignmentLabels.length > 0 ? assignmentLabels.join(", ") : principal.personaLabel ?? humanize(principal.personaId)}</dd></div>
          <div><dt>Access boundary</dt><dd>{capsuleLabels}</dd></div>
          <div><dt>Classification ceiling</dt><dd>{principal.ceiling ? humanize(principal.ceiling) : "Policy defined"}</dd></div>
        </dl>
      </section>

      <section className="data-runbar card" aria-label="Authorized data controls">
        <div className="field">
          <label htmlFor="authorized-purpose">Business purpose</label>
          <select
            id="authorized-purpose"
            value={activePurpose}
            disabled={metadataLoading || purposes.length === 0 || loading}
            onChange={(event) => { clearAuthorizedState(); setPurpose(event.target.value); }}
          >
            {purposes.length === 0 && <option value="">No authorized purpose</option>}
            {purposes.map((item) => <option key={item} value={item}>{humanize(item)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="authorized-page-size">Rows per page</label>
          <select
            id="authorized-page-size"
            value={limit}
            disabled={loading}
            onChange={(event) => { clearAuthorizedState(); setLimit(Number(event.target.value) as (typeof PAGE_SIZES)[number]); }}
          >
            {PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </div>
        <button className="btn primary data-run-button" disabled={!activePurpose || loading || metadataLoading} onClick={runFirstPage}>
          <Icon name={loading ? "refresh" : "shield"} />{loading ? "Evaluating access…" : "Run authorized view"}
        </button>
        <div className="data-run-note"><Icon name="lock" /><span>Identity comes from the signed token. Row scope and field projection run before the API returns records.</span></div>
      </section>

      {metadataError && <div className="data-notice warning" role="status"><Icon name="warning" /><span>Purpose metadata could not be refreshed, so no data purpose will be enabled until the bound contracts are available. {metadataError}</span></div>}

      {!hasRun ? (
        <div className="data-start-state card">
          <Icon name="data" />
          <h2>Ready when you are</h2>
          <p>Select the trusted purpose and run the authorized view. No record request has been sent yet.</p>
        </div>
      ) : loading ? (
        <DataLoading />
      ) : error ? (
        <div className="data-error" role="alert">
          <Icon name="warning" />
          <div><h2>Unable to run this view</h2><p>{error}</p><button className="btn secondary small" onClick={() => void fetchPage(cursorHistory[pageIndex], pageIndex)}><Icon name="refresh" />Try again</button></div>
        </div>
      ) : result ? (
        <AuthorizedResult
          principal={principal}
          result={result}
          page={pageIndex + 1}
          onPrevious={previousPage}
          onNext={nextPage}
        />
      ) : null}
    </section>
  );
}

function AuthorizedResult({
  principal,
  result,
  page,
  onPrevious,
  onNext,
}: {
  principal: Principal;
  result: WarehouseRecordsPage;
  page: number;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const allowed = result.receipt.effect === "allow";
  const effectiveRoleLabels = [...new Set(result.receipt.effectiveAssignments.map((assignment) => assignment.personaLabel))];
  const columns = columnsFor(result);
  const facetGroups: Array<{ label: string; values: WarehouseFacet[] }> = [
    { label: "Products", values: result.facets.products },
    { label: "Tenants", values: result.facets.tenants },
    { label: "Regions", values: result.facets.regions },
    { label: "Departments", values: result.facets.departments },
    { label: "Sensitivity", values: result.facets.sensitivities },
    { label: "Sources", values: result.facets.sources },
  ];
  const nonEmptyFacets = facetGroups.filter((group) => group.values.length > 0);

  return (
    <div className="data-results">
      <section className={`data-decision ${allowed ? "allow" : "deny"}`} aria-live="polite">
        <Icon name={allowed ? "check" : "lock"} />
        <div>
          <span>Policy decision</span>
          <b>{allowed ? "Authorized view released" : "Access denied"}</b>
          <small>{humanize(result.receipt.reason)} · {humanize(result.purpose)}</small>
        </div>
      </section>

      <section className="data-metrics" aria-label="Authorized result metrics">
        {typeof result.total === "number" && <Metric value={formatNumber(result.total)} label="Dataset total" note="Visible only to Data Owner" />}
        <Metric value={formatNumber(result.visible)} label="Authorized rows" note="Within this identity's policy" tone="teal" />
        <Metric value={formatNumber(result.records.length)} label="Rows on this page" note={`Cursor page ${page}`} />
        <Metric value={formatNumber(result.lineage.length)} label="Authorized pipelines" note="Lineage in the released slice" />
        <Metric value={formatNumber(result.receipt.protectedFieldCount)} label="Protected fields" note="Omitted before response" tone={result.receipt.protectedFieldCount ? "amber" : ""} />
      </section>

      <section className="data-context-grid">
        <article className="data-rules card">
          <div className="data-section-head"><div><span className="step-kicker">Access rules</span><h2>Why this view is allowed</h2></div><span className="secure-chip"><Icon name="shield" /> Server enforced</span></div>
          <dl>
            <div><dt>Subject</dt><dd>{principal.displayName} <code>{result.receipt.subjectId}</code></dd></div>
            <div><dt>Effective assigned role</dt><dd>{effectiveRoleLabels.length > 0 ? effectiveRoleLabels.join(", ") : "No matching assignment"}</dd></div>
            <div><dt>Token persona</dt><dd>{principal.personaLabel ?? humanize(result.receipt.tokenPersonaId)}</dd></div>
            <div><dt>Purpose</dt><dd>{humanize(result.purpose)}</dd></div>
            <div><dt>Dataset</dt><dd>{result.dataset.name}</dd></div>
            <div><dt>Classification</dt><dd>{humanize(result.dataset.classification)}</dd></div>
            <div><dt>Contracts</dt><dd>{codeList(result.receipt.contractIds, "No matching contract")}</dd></div>
            <div><dt>Capsules</dt><dd>{codeList(result.receipt.capsuleIds, "No active capsule")}</dd></div>
          </dl>
          <FieldProjection allowed={result.dataset.allowedFields ?? result.receipt.allowedFields} denied={result.receipt.denyFields} protectedCount={result.receipt.protectedFieldCount} />
        </article>

        <article className="data-receipt card">
          <div className="data-section-head"><div><span className="step-kicker">Decision evidence</span><h2>Authorization receipt</h2></div><span className={`status ${allowed ? "allow" : "deny"}`}><span />{allowed ? "Allow" : "Deny"}</span></div>
          <div className="receipt-path"><span>Token subject</span><b>{result.receipt.subjectId}</b><i>→</i><span>Assigned persona</span><b>{result.receipt.effectiveAssignments.map((assignment) => assignment.personaId).join(", ") || "none"}</b><i>→</i><span>Decision</span><b>{humanize(result.receipt.reason)}</b></div>
          {(result.receipt.auditSeq !== undefined || result.receipt.auditHash) && <dl className="receipt-evidence"><div><dt>Audit sequence</dt><dd>{result.receipt.auditSeq ?? "Not returned"}</dd></div><div><dt>Audit hash</dt><dd><code>{result.receipt.auditHash ?? "Not returned"}</code></dd></div></dl>}
          <p>The receipt describes the server decision that produced this response. It never grants additional access in the browser.</p>
        </article>
      </section>

      {result.lineage.length > 0 && (
        <section className="data-lineage card" aria-labelledby="lineage-title">
          <div className="data-section-head"><div><span className="step-kicker">Pipeline lineage</span><h2 id="lineage-title">Sources represented in this authorized slice</h2></div><small>Counts are policy-filtered</small></div>
          <div className="lineage-grid">{result.lineage.map((item) => (
            <article key={item.pipelineId}>
              <span>{item.pipelineName}</span>
              <div><b>{item.sourceSystem}</b><i>→</i><b>{item.targetSystem}</b></div>
              <small>{formatNumber(item.count)} authorized rows · <code>{item.pipelineId}</code></small>
            </article>
          ))}</div>
        </section>
      )}

      {nonEmptyFacets.length > 0 && (
        <section className="data-facets card" aria-labelledby="facets-title">
          <div className="data-section-head"><div><span className="step-kicker">Authorized facets</span><h2 id="facets-title">What is inside this role slice</h2></div><small>Breakdowns never include denied rows</small></div>
          <div className="facet-grid">{nonEmptyFacets.map((group) => (
            <div key={group.label}><h3>{group.label}</h3><ul>{group.values.map((item) => <li key={item.key}><span>{humanize(item.key)}</span><b>{formatNumber(item.count)}</b></li>)}</ul></div>
          ))}</div>
        </section>
      )}

      {allowed && result.records.length > 0 ? (
        <WarehouseRecords
          records={result.records}
          columns={columns}
          name={principal.displayName}
          page={page}
          hasNext={result.nextCursor !== undefined}
          onPrevious={onPrevious}
          onNext={onNext}
        />
      ) : (
        <div className="data-empty card">
          <Icon name="lock" />
          <h2>{allowed ? "No authorized records on this page" : "No records released"}</h2>
          <p>{allowed ? "The authorized slice is empty." : "No row or field values were returned for this identity and purpose."}</p>
        </div>
      )}
    </div>
  );
}

function WarehouseRecords({
  records,
  columns,
  name,
  page,
  hasNext,
  onPrevious,
  onNext,
}: {
  records: Array<Record<string, unknown>>;
  columns: string[];
  name: string;
  page: number;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <section className="warehouse-records card" aria-labelledby="authorized-records-title">
      <div className="table-head">
        <div><h2 id="authorized-records-title">{name}'s authorized records</h2><p>{formatNumber(records.length)} records on cursor page {page}</p></div>
        <span className="secure-chip"><Icon name="shield" /> Field projected</span>
      </div>
      <div className="warehouse-desktop-table">
        <div className="table-wrap"><table data-testid="authorized-records"><caption>Policy-filtered unified data records</caption><thead><tr>{columns.map((column) => <th scope="col" key={column}>{humanize(column)}</th>)}</tr></thead><tbody>{records.map((record, index) => <tr key={String(record.id ?? `row-${index}`)}>{columns.map((column) => <td key={column}>{formatValue(record[column])}</td>)}</tr>)}</tbody></table></div>
      </div>
      <div className="warehouse-mobile-list">{records.map((record, index) => {
        const key = String(record.id ?? `row-${index}`);
        const summary = String(record.pipeline_name ?? record.product ?? `Record ${key}`);
        return <details key={key}><summary><span><b>{summary}</b><small>{String(record.tenant ?? record.source_system ?? key)}</small></span><span className="status allow"><span />Authorized</span></summary><dl>{columns.map((column) => <div key={column}><dt>{humanize(column)}</dt><dd>{formatValue(record[column])}</dd></div>)}</dl></details>;
      })}</div>
      <nav className="data-pagination" aria-label="Data pages">
        <button className="btn secondary small" disabled={page === 1} onClick={onPrevious}><span aria-hidden="true">←</span>Previous</button>
        <span aria-live="polite">Page {page}</span>
        <button className="btn secondary small" disabled={!hasNext} onClick={onNext}>Next<span aria-hidden="true">→</span></button>
      </nav>
    </section>
  );
}

function FieldProjection({ allowed, denied, protectedCount }: { allowed: string[]; denied: string[]; protectedCount: number }) {
  const returned = allowed.filter((field) => !denied.some((protectedField) =>
    protectedField === field || protectedField.startsWith(`${field}.`) || field.startsWith(`${protectedField}.`)
  ));
  return <div className="field-projection"><div><span>Returned fields</span><div>{returned.length > 0 ? returned.map((field) => <code key={field}>{humanize(field)}</code>) : <em>None</em>}</div></div><div className="protected"><span>Protected fields</span><div>{denied.length > 0 ? denied.map((field) => <code key={field}><Icon name="lock" />{humanize(field)}</code>) : protectedCount > 0 ? <em>{protectedCount} field names withheld by policy</em> : <em>None</em>}</div></div></div>;
}

function Metric({ value, label, note, tone = "" }: { value: string; label: string; note: string; tone?: string }) {
  return <article className={tone}><b>{value}</b><span>{label}</span><small>{note}</small></article>;
}

function DataLoading() {
  return <div className="data-loading" role="status" aria-label="Running authorized data view"><span /><span /><span /><span /></div>;
}

function columnsFor(result: WarehouseRecordsPage): string[] {
  const actual = new Set(result.records.flatMap((record) => Object.keys(record)));
  const ordered = [...PREFERRED_COLUMNS].filter((field) => actual.has(field));
  const allowedOrder = result.receipt.allowedFields.filter((field) => actual.has(field) && !ordered.includes(field as (typeof PREFERRED_COLUMNS)[number]));
  const remaining = [...actual].filter((field) => !ordered.includes(field as (typeof PREFERRED_COLUMNS)[number]) && !allowedOrder.includes(field)).sort();
  return [...ordered, ...allowedOrder, ...remaining];
}

function codeList(values: string[], empty: string) {
  if (values.length === 0) return empty;
  return <span className="inline-code-list">{values.map((value) => <code key={value}>{value}</code>)}</span>;
}

function initials(value: string) {
  return value.split(/[.\s_-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
}

function humanize(value: string) {
  return value.replaceAll("_", " ").replaceAll(".", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatNumber(value: number) {
  return new Intl.NumberFormat(undefined, { notation: value >= 100_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function formatValue(value: unknown) {
  if (value === undefined || value === null || value === "") return <span className="muted">Not available</span>;
  if (typeof value === "number") return value.toLocaleString();
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
