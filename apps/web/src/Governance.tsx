import { useEffect, useId, useMemo, useState } from "react";
import {
  api,
  type GovernanceReviewerRole,
  type Principal,
  type RecertificationCampaignSummary,
  type RecertificationEvidenceReport,
  type RecertificationItem,
} from "./api";
import { useModalFocus } from "./focus";
import { Icon } from "./Icons";

const PAGE_SIZE = 50;

export function Recertifications({
  principal,
  admin,
  onSuccess,
}: {
  principal: Principal;
  admin: boolean;
  onSuccess: (message: string) => void;
}) {
  const reviewerRole: GovernanceReviewerRole = admin ? "governance-admin" : "data-owner";
  const [campaigns, setCampaigns] = useState<RecertificationCampaignSummary[]>([]);
  const [campaignTotal, setCampaignTotal] = useState(0);
  const [campaignCursor, setCampaignCursor] = useState<number | undefined>();
  const [selectedId, setSelectedId] = useState("");
  const [items, setItems] = useState<RecertificationItem[]>([]);
  const [itemTotal, setItemTotal] = useState(0);
  const [itemCursor, setItemCursor] = useState<number | undefined>();
  const [evidence, setEvidence] = useState<RecertificationEvidenceReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [creating, setCreating] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const [decisionTarget, setDecisionTarget] = useState<{ item: RecertificationItem; decision: "attest" | "revoke" } | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api.recertifications({ limit: PAGE_SIZE }, controller.signal)
      .then((result) => {
        setCampaigns(result.campaigns);
        setCampaignTotal(result.total);
        setCampaignCursor(result.nextCursor);
        setSelectedId((current) => result.campaigns.some((campaign) => campaign.id === current) ? current : result.campaigns[0]?.id ?? "");
      })
      .catch((cause) => { if (!controller.signal.aborted) setError(errorMessage(cause, "Unable to load recertification campaigns")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    if (!selectedId) {
      setItems([]);
      setEvidence(null);
      setItemTotal(0);
      setItemCursor(undefined);
      return;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError(null);
    Promise.all([
      api.recertificationItems(selectedId, { limit: PAGE_SIZE }, controller.signal),
      api.recertificationEvidence(selectedId, controller.signal),
    ]).then(([itemPage, report]) => {
      setItems(itemPage.items);
      setItemTotal(itemPage.total);
      setItemCursor(itemPage.nextCursor);
      setEvidence(report);
      setCampaigns((current) => current.map((campaign) => campaign.id === itemPage.campaign.id ? itemPage.campaign : campaign));
    }).catch((cause) => { if (!controller.signal.aborted) setDetailError(errorMessage(cause, "Unable to load campaign evidence")); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [selectedId, refresh]);

  const selected = campaigns.find((campaign) => campaign.id === selectedId);
  const reviewableCount = useMemo(() => items.filter((item) => canReview(item, principal.id, reviewerRole, selected?.status)).length, [items, principal.id, reviewerRole, selected?.status]);

  async function loadMoreCampaigns() {
    if (campaignCursor === undefined || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await api.recertifications({ cursor: campaignCursor, limit: PAGE_SIZE });
      setCampaigns((current) => mergeById(current, result.campaigns));
      setCampaignTotal(result.total);
      setCampaignCursor(result.nextCursor);
    } catch (cause) { setError(errorMessage(cause, "Unable to load more campaigns")); }
    finally { setLoadingMore(false); }
  }

  async function loadMoreItems() {
    if (!selectedId || itemCursor === undefined || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await api.recertificationItems(selectedId, { cursor: itemCursor, limit: PAGE_SIZE });
      setItems((current) => mergeById(current, result.items));
      setItemTotal(result.total);
      setItemCursor(result.nextCursor);
    } catch (cause) { setDetailError(errorMessage(cause, "Unable to load more review items")); }
    finally { setLoadingMore(false); }
  }

  async function createCampaign(input: { name: string; dueAt: number; cadenceDays: number }) {
    setCreating(true);
    setError(null);
    try {
      const result = await api.createRecertification(input);
      setCampaigns((current) => [result, ...current.filter((campaign) => campaign.id !== result.id)]);
      setCampaignTotal((current) => current + 1);
      setSelectedId(result.id);
      setItems(result.items);
      setItemTotal(result.items.length);
      setItemCursor(undefined);
      setEvidence(null);
      onSuccess(`Recertification campaign “${result.name}” created with ${result.itemCount} frozen access items.`);
    } catch (cause) {
      setError(errorMessage(cause, "Unable to create recertification campaign"));
    } finally { setCreating(false); }
  }

  async function renewCampaign() {
    if (!selected || selected.status === "active") return;
    setRenewing(true);
    setDetailError(null);
    try {
      const result = await api.renewRecertification(selected.id);
      setCampaigns((current) => [result, ...current.filter((campaign) => campaign.id !== result.id)]);
      setCampaignTotal((current) => current + 1);
      setSelectedId(result.id);
      setItems(result.items);
      setItemTotal(result.items.length);
      setItemCursor(undefined);
      setEvidence(null);
      onSuccess(`Renewed “${result.name}” with ${result.itemCount} current access items.`);
    } catch (cause) { setDetailError(errorMessage(cause, "Unable to renew this campaign")); }
    finally { setRenewing(false); }
  }

  async function decide(reason: string) {
    if (!decisionTarget || !selected) return;
    setDeciding(true);
    setDecisionError(null);
    try {
      const result = await api.decideRecertification(selected.id, decisionTarget.item.id, decisionTarget.decision, reason);
      setItems((current) => current.map((item) => item.id === result.item.id ? result.item : item));
      setCampaigns((current) => current.map((campaign) => campaign.id === result.campaign.id ? result.campaign : campaign));
      const report = await api.recertificationEvidence(selected.id);
      setEvidence(report);
      onSuccess(decisionTarget.decision === "attest"
        ? `Access for ${result.item.principalId} was attested with evidence.`
        : `Access for ${result.item.principalId} was revoked and the membership removed.`);
      setDecisionTarget(null);
    } catch (cause) { setDecisionError(errorMessage(cause, "Unable to record this recertification decision")); }
    finally { setDeciding(false); }
  }

  return <>
    <header className="page-head">
      <div><div className="eyebrow">Governance · Standing access</div><h1>Access recertification</h1><p className="lead">Re-attest every active human membership against its current capsule and persona. Decisions are independently authorized, reasoned, and linked to audit evidence.</p></div>
      <div className="page-actions"><button className="btn secondary" onClick={() => setRefresh((value) => value + 1)}><Icon name="refresh" />Refresh evidence</button></div>
    </header>

    {admin && <CampaignCreateForm creating={creating} onCreate={createCampaign} />}
    <section className="reviewer-scope-note"><Icon name="shield" /><div><b>Acting as {reviewerRoleLabel(reviewerRole)}</b><span>You can decide only items eligible for this reviewer role, and never your own access. {admin ? "Campaign creation and manual renewal are available because this identity is also a control-plane administrator." : "Administrative authoring, lifecycle, compiler, and audit controls are not exposed to this Data Owner session."}</span></div></section>
    <section className="recert-lifecycle-boundary" role="note"><Icon name="refresh" /><div><b>Explicit lifecycle boundary</b><span>Campaign expiry is refreshed lazily when a governance API is accessed. Overdue campaigns stop accepting decisions but do not automatically revoke access. Renewal is manual; this build has no scheduler or notification worker.</span></div></section>

    {error ? <InlineGovernanceError message={error} onRetry={() => setRefresh((value) => value + 1)} /> : loading ? <GovernanceSkeleton /> : campaigns.length === 0 ? <section className="empty-state card"><Icon name="audit" /><h2>No recertification campaigns</h2><p>{admin ? "Create a campaign to freeze the current human access inventory for review." : "A Governance Admin has not created a campaign yet."}</p></section> : (
      <div className="recert-layout">
        <aside className="campaign-rail card" aria-label="Recertification campaigns">
          <header><div><span>Campaigns</span><b>{campaignTotal} total</b></div><small>Select a frozen review window</small></header>
          <div className="campaign-list">{campaigns.map((campaign) => <button key={campaign.id} className={campaign.id === selectedId ? "active" : ""} aria-pressed={campaign.id === selectedId} onClick={() => setSelectedId(campaign.id)}>
            <span className={`campaign-status ${campaign.status}`}><i />{humanize(campaign.status)}</span>
            <b>{campaign.name}</b>
            <small>Due {formatDate(campaign.dueAt)}</small>
            <span className="campaign-meter"><i style={{ width: `${campaign.itemCount ? ((campaign.counts.attested + campaign.counts.revoked + campaign.counts.removed) / campaign.itemCount) * 100 : 100}%` }} /></span>
            <span className="campaign-count">{campaign.counts.pending} pending · {campaign.itemCount} total</span>
          </button>)}</div>
          {campaignCursor !== undefined && <button className="btn secondary small full" disabled={loadingMore} onClick={() => void loadMoreCampaigns()}>{loadingMore ? "Loading…" : "Load more campaigns"}</button>}
        </aside>

        <main className="campaign-detail">
          {detailError && <InlineGovernanceError message={detailError} onRetry={() => setRefresh((value) => value + 1)} />}
          {detailLoading ? <GovernanceSkeleton compact /> : selected && <>
            <section className="campaign-summary card">
              <div className="campaign-summary-head"><div><span className={`campaign-status ${selected.status}`}><i />{humanize(selected.status)}</span><h2>{selected.name}</h2><p>Created by {selected.createdBy} · {selected.cadenceDays}-day review cadence · manual renewal</p></div>{admin && selected.status !== "active" && <button className="btn secondary" disabled={renewing} onClick={() => void renewCampaign()}><Icon name="refresh" />{renewing ? "Renewing…" : "Renew campaign"}</button>}</div>
              <div className="recert-stats"><div><span>Pending</span><b>{selected.counts.pending}</b></div><div><span>Attested</span><b>{selected.counts.attested}</b></div><div><span>Revoked</span><b>{selected.counts.revoked}</b></div><div><span>Removed by drift</span><b>{selected.counts.removed}</b></div><div><span>You can review</span><b>{reviewableCount}</b></div></div>
            </section>

            <section className="recert-items card">
              <header><div><span className="section-kicker">Frozen access inventory</span><h2>Membership decisions</h2></div><span className="secure-chip"><Icon name="lock" /> Reason required</span></header>
              {items.length === 0 ? <div className="empty-state compact"><Icon name="check" /><h2>No access items</h2><p>This campaign captured no active human memberships.</p></div> : <div className="table-wrap"><table><caption>Recertification access items</caption><thead><tr><th scope="col">Principal</th><th scope="col">Capsule / persona</th><th scope="col">Eligible reviewer</th><th scope="col">Evidence status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead><tbody>{items.map((item) => {
                const reviewable = canReview(item, principal.id, reviewerRole, selected.status);
                return <tr key={item.id}><td><b>{item.principalId}</b><small className="cell-sub"><code>{item.id}</code></small></td><td><code>{item.capsuleId}</code><small className="cell-sub">{humanize(item.personaId)} · assignment <code>{item.assignmentId}</code></small></td><td>{item.eligibleReviewerRoles.map(reviewerRoleLabel).join(" or ")}<small className="cell-sub">{item.principalId === principal.id ? "Self-review blocked" : "Independent decision"}</small></td><td><RecertificationItemStatus item={item} /></td><td className="actions-cell">{reviewable ? <div className="recert-actions"><button className="btn small secondary" onClick={() => { setDecisionError(null); setDecisionTarget({ item, decision: "attest" }); }}>Attest</button><button className="btn small danger-outline" onClick={() => { setDecisionError(null); setDecisionTarget({ item, decision: "revoke" }); }}>Revoke</button></div> : <span className="muted">{item.status !== "pending" ? "Decision recorded" : item.principalId === principal.id ? "Another reviewer required" : "Other reviewer role required"}</span>}</td></tr>;
              })}</tbody></table></div>}
              {itemCursor !== undefined && <footer><button className="btn secondary small" disabled={loadingMore} onClick={() => void loadMoreItems()}>{loadingMore ? "Loading…" : `Load more (${items.length} of ${itemTotal})`}</button></footer>}
            </section>

            <EvidencePanel report={evidence} />
          </>}
        </main>
      </div>
    )}
    {decisionTarget && selected && <RecertificationDecisionDialog campaign={selected} target={decisionTarget} working={deciding} error={decisionError} onClose={() => setDecisionTarget(null)} onConfirm={decide} />}
  </>;
}

function CampaignCreateForm({ creating, onCreate }: { creating: boolean; onCreate: (input: { name: string; dueAt: number; cadenceDays: number }) => void }) {
  const nameId = useId();
  const dueId = useId();
  const cadenceId = useId();
  const [name, setName] = useState("Quarterly access certification");
  const [dueDate, setDueDate] = useState(defaultDueDate());
  const [cadence, setCadence] = useState("90");
  const dueAt = new Date(`${dueDate}T23:59:59`).getTime();
  const cadenceDays = Number(cadence);
  const valid = name.trim().length > 0 && Number.isSafeInteger(dueAt) && dueAt > Date.now() && Number.isSafeInteger(cadenceDays) && cadenceDays >= 1 && cadenceDays <= 365;
  return <form className="campaign-create card" onSubmit={(event) => { event.preventDefault(); if (valid) onCreate({ name: name.trim(), dueAt, cadenceDays }); }}>
    <div className="campaign-create-copy"><span className="section-kicker">Governance Admin</span><h2>Start a review campaign</h2><p>Freeze all current active human memberships into independently reviewable items.</p></div>
    <div className="field"><label htmlFor={nameId}>Campaign name</label><input id={nameId} value={name} onChange={(event) => setName(event.target.value)} /></div>
    <div className="field"><label htmlFor={dueId}>Due date</label><input id={dueId} type="date" min={tomorrowDate()} value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></div>
    <div className="field"><label htmlFor={cadenceId}>Review cadence (days)</label><input id={cadenceId} type="number" min={1} max={365} value={cadence} onChange={(event) => setCadence(event.target.value)} /></div>
    <button className="btn primary" disabled={creating || !valid}><Icon name="audit" />{creating ? "Creating…" : "Create campaign"}</button>
  </form>;
}

function RecertificationItemStatus({ item }: { item: RecertificationItem }) {
  const effect = item.status === "attested" ? "allow" : item.status === "pending" ? "pending" : "deny";
  return <div className="recert-item-status"><span className={`status ${effect}`}><span />{humanize(item.status)}</span>{item.decidedBy && <small>{item.reviewerRole === "system" ? "System" : item.reviewerRole ? reviewerRoleLabel(item.reviewerRole) : "Reviewer"} · {item.decidedBy}</small>}{item.evidence && <small>Audit #{item.evidence.auditSeq} · {item.evidence.auditHash.slice(0, 10)}…</small>}</div>;
}

function EvidencePanel({ report }: { report: RecertificationEvidenceReport | null }) {
  return <section className="recert-evidence card">
    <header><div><span className="section-kicker">Decision evidence</span><h2>Audit-linked receipts</h2></div><span className={`chain-badge ${report?.auditChainValid ? "valid" : "unknown"}`}><Icon name={report?.auditChainValid ? "check" : "warning"} />{report ? report.auditChainValid ? "Audit chain valid" : "Audit chain invalid" : "Evidence pending"}</span></header>
    {!report ? <p className="muted">Evidence will appear after the campaign details are loaded.</p> : report.decisions.length === 0 ? <p className="muted">No decisions have been recorded for this campaign.</p> : <div className="evidence-receipts">{report.decisions.slice().reverse().map((decision) => <article key={decision.itemId}><span className={`decision-mark ${decision.status}`}><Icon name={decision.status === "attested" ? "check" : "close"} /></span><div><b>{decision.principalId} · {humanize(decision.status)}</b><small>{decision.capsuleId} · assignment {decision.assignmentId} · {decision.reason}</small></div><code>#{decision.evidence.auditSeq} {decision.evidence.auditHash.slice(0, 12)}…</code></article>)}</div>}
  </section>;
}

function RecertificationDecisionDialog({ campaign, target, working, error, onClose, onConfirm }: { campaign: RecertificationCampaignSummary; target: { item: RecertificationItem; decision: "attest" | "revoke" }; working: boolean; error: string | null; onClose: () => void; onConfirm: (reason: string) => void }) {
  const titleId = useId();
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const modalRef = useModalFocus<HTMLElement>(onClose, working);
  const revoking = target.decision === "revoke";
  return <div className="modal-backdrop"><section ref={modalRef} className="modal recert-decision-modal" role={revoking ? "alertdialog" : "dialog"} aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
    <div className={`modal-icon ${revoking ? "danger" : ""}`}><Icon name={revoking ? "warning" : "check"} /></div><div className="eyebrow">{revoking ? "Remove standing access" : "Confirm current need"}</div><h2 id={titleId}>{revoking ? "Revoke" : "Attest"} {target.item.principalId}?</h2>
    <p className="lead">Campaign: {campaign.name}. {revoking ? "This removes the exact capsule membership immediately and records a revocation receipt." : "This preserves the current membership and records why it remains required."}</p>
    <dl className="review-grid"><div><dt>Capsule</dt><dd><code>{target.item.capsuleId}</code></dd></div><div><dt>Assignment</dt><dd><code>{target.item.assignmentId}</code></dd></div><div><dt>Persona</dt><dd>{humanize(target.item.personaId)}</dd></div><div><dt>Eligible roles</dt><dd>{target.item.eligibleReviewerRoles.map(reviewerRoleLabel).join(", ")}</dd></div><div><dt>Decision effect</dt><dd>{revoking ? "Membership removed" : "Membership retained"}</dd></div></dl>
    <div className="field"><label htmlFor={reasonId}>Evidence-based reason</label><textarea id={reasonId} rows={4} value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} placeholder={revoking ? "Example: Team ownership ended; ticket OFF-2048" : "Example: Still required for quarterly vendor reconciliation; owner confirmed"} /><small>Required, 3–500 characters. Stored with reviewer identity and audit hash.</small></div>
    {error && <div className="dialog-error" role="alert"><Icon name="warning" /><span>{error}</span></div>}
    <div className="modal-actions"><button data-autofocus className="btn secondary" disabled={working} onClick={onClose}>Cancel</button><button className={revoking ? "btn danger" : "btn primary"} disabled={working || reason.trim().length < 3} onClick={() => onConfirm(reason.trim())}>{working ? "Recording evidence…" : revoking ? "Revoke membership" : "Attest access"}</button></div>
  </section></div>;
}

function InlineGovernanceError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="inline-state error" role="alert"><Icon name="warning" /><div><h2>Unable to refresh this view</h2><p>{message}</p><button className="btn secondary small" onClick={onRetry}><Icon name="refresh" />Try again</button></div></div>;
}

function GovernanceSkeleton({ compact = false }: { compact?: boolean }) {
  return <div className={`governance-skeleton ${compact ? "compact" : ""}`} role="status" aria-label="Loading recertification evidence"><span /><span /><span /></div>;
}

function canReview(item: RecertificationItem, actorId: string, role: GovernanceReviewerRole, campaignStatus?: string) {
  return campaignStatus === "active" && item.status === "pending" && item.principalId !== actorId && item.eligibleReviewerRoles.includes(role);
}

function reviewerRoleLabel(role: GovernanceReviewerRole) {
  return role === "data-owner" ? "Data Owner" : "Governance Admin";
}

function mergeById<T extends { id: string }>(current: T[], additions: T[]) {
  const known = new Set(current.map((item) => item.id));
  return [...current, ...additions.filter((item) => !known.has(item.id))];
}

function defaultDueDate() {
  const date = new Date();
  date.setDate(date.getDate() + 30);
  return localDateInput(date);
}

function tomorrowDate() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return localDateInput(date);
}

function localDateInput(date: Date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function formatDate(value: number | string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function humanize(value: string) {
  return value.replaceAll("-", " ").replaceAll("_", " ").replaceAll(".", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}
