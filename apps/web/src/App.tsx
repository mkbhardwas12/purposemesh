import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  api,
  ApiError,
  getToken,
  setToken,
  tokenExpiresAt,
  UNAUTHORIZED_EVENT,
  type AuditEvent,
  type Catalog,
  type CompiledPolicy,
  type DirectoryUser,
  type GovernanceReviewerRole,
  type JitGrant,
  type Principal,
  type RecordRow,
  type RoleRequest,
  type SodViolation,
  type Surface,
} from "./api";
import { Dashboard } from "./Dashboard";
import { AuthorizedDataView } from "./DataView";
import { Recertifications } from "./Governance";
import { decisionLabel } from "./format";
import { focusableElements, useModalFocus } from "./focus";
import { Icon, type IconName } from "./Icons";

type View = "overview" | "surfaces" | "data" | "jit" | "request" | "architecture" | "roles" | "reviews" | "recertifications" | "capsules" | "compiler" | "audit";

const ACCESS_NAV: Array<{ id: View; label: string; detail: string; icon: IconName }> = [
  { id: "overview", label: "Access overview", detail: "Authorized analytics", icon: "activity" },
  { id: "surfaces", label: "Effective access", detail: "Decision explanations", icon: "shield" },
  { id: "data", label: "Data", detail: "Authorized records", icon: "data" },
  { id: "jit", label: "JIT access", detail: "Request or approve", icon: "key" },
];

const SELF_SERVICE_NAV: Array<{ id: View; label: string; detail: string; icon: IconName }> = [
  { id: "request", label: "Request a role", detail: "Draft and submit access", icon: "roles" },
];

const GOVERNANCE_NAV: Array<{ id: View; label: string; detail: string; icon: IconName }> = [
  { id: "architecture", label: "Architecture", detail: "Model, lineage & assurance", icon: "spark" },
  { id: "roles", label: "Role studio", detail: "Author and assign", icon: "roles" },
  { id: "reviews", label: "Access reviews", detail: "Approve role requests", icon: "check" },
  { id: "recertifications", label: "Recertification", detail: "Re-attest standing access", icon: "refresh" },
  { id: "capsules", label: "Capsule lifecycle", detail: "Membership and revoke", icon: "capsule" },
  { id: "compiler", label: "Policy compiler", detail: "Native enforcement", icon: "code" },
  { id: "audit", label: "Audit trail", detail: "Integrity and evidence", icon: "audit" },
];

const REVIEWER_NAV = GOVERNANCE_NAV.filter((item) => item.id === "reviews" || item.id === "recertifications");

const EVIDENCE_PAGE_SIZE = 25;

export function App() {
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [boot, setBoot] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const token = getToken();
    if (!token) {
      setBoot(false);
      return () => controller.abort();
    }
    api.me(controller.signal)
      .then(setPrincipal)
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && cause.status === 401) setToken(null);
        else setError("We could not restore your session. Check the control-plane connection and try again.");
      })
      .finally(() => { if (!controller.signal.aborted) setBoot(false); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!principal) {
      setSessionNotice(null);
      return;
    }
    const expiresAt = tokenExpiresAt(getToken());
    if (!expiresAt) return;
    const warnIn = Math.max(0, expiresAt - Date.now() - 120_000);
    const expireIn = Math.max(0, expiresAt - Date.now());
    const warning = window.setTimeout(() => {
      setSessionNotice("Your session expires in under two minutes. Save or submit changes; unfinished role drafts will be restored after sign-in.");
    }, warnIn);
    const expiry = window.setTimeout(() => {
      setToken(null);
      setPrincipal(null);
      setSessionNotice(null);
      setError("Your session expired. Sign in again to continue; any unfinished role draft remains in this browser tab.");
    }, expireIn);
    return () => {
      window.clearTimeout(warning);
      window.clearTimeout(expiry);
    };
  }, [principal]);

  useEffect(() => {
    const expire = () => {
      setToken(null);
      setPrincipal(null);
      setError("Your session expired. Sign in again to continue.");
    };
    window.addEventListener(UNAUTHORIZED_EVENT, expire);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, expire);
  }, []);

  if (boot) return <BootScreen />;
  if (!principal) {
    return (
      <Login
        initialError={error}
        onLogin={(token, next) => {
          setToken(token);
          setPrincipal(next);
          setError(null);
        }}
      />
    );
  }

  return (
    <Shell
      principal={principal}
      initialError={error}
      sessionNotice={sessionNotice}
      onDismissSessionNotice={() => setSessionNotice(null)}
      onLogout={() => {
        setToken(null);
        setPrincipal(null);
        setError(null);
        setSessionNotice(null);
      }}
    />
  );
}

function BootScreen() {
  return (
    <main className="boot-screen" aria-label="Loading PurposeMesh control plane">
      <div className="brand-mark large"><Icon name="shield" /></div>
      <div><b>PurposeMesh Control Plane</b><span>Restoring session…</span></div>
      <div className="boot-line" />
    </main>
  );
}

function Login({
  initialError,
  onLogin,
}: {
  initialError: string | null;
  onLogin: (token: string, principal: Principal) => void;
}) {
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [demoPassword, setDemoPassword] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(initialError);
  const [loadingDirectory, setLoadingDirectory] = useState(true);
  const [brokerRequired, setBrokerRequired] = useState(false);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const usernameId = useId();
  const passwordId = useId();

  useEffect(() => {
    const controller = new AbortController();
    api.directory(controller.signal)
      .then((directory) => {
        setUsers(directory.users);
        setDemoPassword(directory.password ?? "");
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && cause.status === 404) {
          setBrokerRequired(true);
          setUsers([]);
          setDemoPassword("");
          setError(null);
        } else {
          setError("Sign-in configuration is unavailable. Try again later or contact your platform administrator.");
        }
      })
      .finally(() => { if (!controller.signal.aborted) setLoadingDirectory(false); });
    return () => controller.abort();
  }, []);

  async function enter(nextUsername: string, nextPassword: string) {
    if (!nextUsername.trim() || !nextPassword) {
      setError("Enter both a username and password.");
      return;
    }
    setError(null);
    setSigningIn(nextUsername);
    try {
      const result = await api.login(nextUsername.trim(), nextPassword);
      window.location.hash = "#/data";
      onLogin(result.token, result.principal);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-in failed");
    } finally {
      setSigningIn(null);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-story" aria-labelledby="login-title">
        <div className="brand-lockup">
          <div className="brand-mark"><Icon name="shield" /></div>
          <div><b>PurposeMesh</b><span>Purpose-bound authorization</span></div>
        </div>
        <div className="login-copy">
          <div className="eyebrow">Policy that follows the work</div>
          <h1 id="login-title">Purpose-bound access.<br />Every governed path.</h1>
          <p>A portable reference model for SAP, BW, Elasticsearch, analytics, and workload identities—with explainable decisions and reversible lifecycle controls across the modeled estate.</p>
        </div>
        <div className="trust-row">
          <span><Icon name="lock" /> Row + field obligations</span>
          <span><Icon name="audit" /> Two-role approvals</span>
          <span><Icon name="spark" /> Fidelity-gated plans</span>
        </div>
      </section>

      <section className="login-panel" aria-labelledby="signin-title">
        {brokerRequired ? (
          <div className="login-form-card broker-required" role="status">
            <div className="broker-icon"><Icon name="lock" /></div>
            <div className="eyebrow">Production identity</div>
            <h2 id="signin-title">Identity broker integration required</h2>
            <p className="lead">Demo password sign-in is disabled in this environment. Connect the control plane to your organization’s OIDC or SAML identity broker before users can authenticate.</p>
            <div className="broker-guidance">
              <Icon name="shield" />
              <div><b>No credentials are accepted on this screen</b><span>A platform administrator must configure the trusted identity handoff and then expose its sign-in entry point.</span></div>
            </div>
          </div>
        ) : <div className="login-form-card">
          <div className="eyebrow">Authorization workspace</div>
          <h2 id="signin-title">Sign in to the control plane</h2>
          <p className="lead">Select a seeded demo persona to explore exact row and field boundaries. Production deployments authenticate through an OIDC or SAML broker.</p>
          {error && <div className="alert error" role="alert"><Icon name="warning" /><span>{error}</span></div>}
          <form onSubmit={(event) => { event.preventDefault(); void enter(username, password); }}>
            <div className="field">
              <label htmlFor={usernameId}>Username</label>
              <input id={usernameId} autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor={passwordId}>Password</label>
              <input id={passwordId} type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
            </div>
            <button className="btn primary full" disabled={Boolean(signingIn)}>
              <Icon name="lock" />{signingIn ? "Signing in…" : "Sign in"}
            </button>
          </form>
          {(loadingDirectory || users.length > 0) && (
            <div className="demo-directory" data-testid="directory">
              <div className="divider"><span>Demo identities</span></div>
              {demoPassword && (
                <div className="demo-credential" role="note">
                  <Icon name="key" />
                  <span>Demo password</span>
                  <code>{demoPassword}</code>
                </div>
              )}
              {loadingDirectory ? (
                <div className="identity-skeleton" role="status" aria-label="Loading demo identities"><span /><span /><span /></div>
              ) : (
                <div className="identity-grid">
                  {users.map((user) => (
                    <button
                      key={user.username}
                      className="identity-card"
                      disabled={Boolean(signingIn) || !demoPassword}
                      onClick={() => void enter(user.username, demoPassword)}
                    >
                      <span className="avatar">{initials(user.displayName ?? user.username)}</span>
                      <span><b>{user.displayName ?? user.username}</b><small>{user.persona} · {user.capsule}</small></span>
                      <Icon name="chevron" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>}
      </section>
    </main>
  );
}

function Shell({
  principal,
  initialError,
  sessionNotice,
  onDismissSessionNotice,
  onLogout,
}: {
  principal: Principal;
  initialError: string | null;
  sessionNotice: string | null;
  onDismissSessionNotice: () => void;
  onLogout: () => void;
}) {
  const admin = isAdmin(principal);
  const dataOwner = isDataOwner(principal);
  const reviewer = admin || dataOwner;
  const accessItems = useMemo(
    () => admin ? ACCESS_NAV : [...ACCESS_NAV, ...SELF_SERVICE_NAV],
    [admin],
  );
  const allowedViews = useMemo(() => [
    ...accessItems.map((item) => item.id),
    ...(admin ? GOVERNANCE_NAV.map((item) => item.id) : dataOwner ? REVIEWER_NAV.map((item) => item.id) : []),
  ], [accessItems, admin, dataOwner]);
  const [view, setView] = useState<View>(() => viewFromHash(allowedViews));
  const [mobileOpen, setMobileOpen] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [success, setSuccess] = useState<string | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const sync = () => setView(viewFromHash(allowedViews));
    window.addEventListener("hashchange", sync);
    if (!allowedViews.includes(view)) navigate(allowedViews[0] ?? "overview", setView);
    return () => window.removeEventListener("hashchange", sync);
  }, [allowedViews, view]);

  useEffect(() => {
    if (!mobileOpen) return;
    const nav = navRef.current;
    if (!nav) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : menuButtonRef.current;
    queueMicrotask(() => nav.querySelector<HTMLElement>(".nav-close")?.focus());
    const containFocus = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(nav);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", containFocus);
    return () => {
      document.removeEventListener("keydown", containFocus);
      if (previous?.isConnected) previous.focus();
    };
  }, [mobileOpen]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mobile = window.matchMedia("(max-width: 900px)");
    const closeAfterResize = () => { if (!mobile.matches) setMobileOpen(false); };
    mobile.addEventListener("change", closeAfterResize);
    return () => mobile.removeEventListener("change", closeAfterResize);
  }, []);

  useEffect(() => {
    if (!success) return;
    const handle = window.setTimeout(() => setSuccess(null), 6_000);
    return () => window.clearTimeout(handle);
  }, [success]);

  useEffect(() => {
    if (window.scrollY !== 0) window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [view]);

  function go(next: View) {
    setError(null);
    setMobileOpen(false);
    navigate(next, setView);
  }

  return (
    <div className="shell">
      <button className="skip-link" type="button" inert={mobileOpen} onClick={() => document.getElementById("main-content")?.focus()}>Skip to content</button>
      <header className="mobile-bar" inert={mobileOpen}>
        <button ref={menuButtonRef} className="icon-btn" aria-label="Open navigation" aria-controls="primary-navigation" aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)}><Icon name="menu" /></button>
        <div className="brand-lockup compact"><div className="brand-mark"><Icon name="shield" /></div><div><b>PurposeMesh</b><span>Control plane</span></div></div>
        <span className="avatar small">{initials(principal.displayName)}</span>
      </header>
      {mobileOpen && <button className="nav-backdrop" tabIndex={-1} aria-hidden="true" onClick={() => setMobileOpen(false)} />}
      <aside ref={navRef} id="primary-navigation" className={`nav ${mobileOpen ? "open" : ""}`}>
        <div className="nav-top">
          <div className="brand-lockup compact"><div className="brand-mark"><Icon name="shield" /></div><div><b>PurposeMesh</b><span>Control plane</span></div></div>
          <button className="icon-btn nav-close" aria-label="Close navigation" onClick={() => setMobileOpen(false)}><Icon name="close" /></button>
        </div>
        <nav aria-label="Primary navigation">
          <NavGroup label="Access" items={accessItems} view={view} onSelect={go} />
          {reviewer && <NavGroup label="Governance" items={admin ? GOVERNANCE_NAV : REVIEWER_NAV} view={view} onSelect={go} />}
        </nav>
        <div className="who">
          <span className="avatar">{initials(principal.displayName)}</span>
          <div className="who-copy"><b>{principal.displayName}</b><span>{principal.personaLabel ?? principal.personaId}</span><small>{principal.capsules.map((capsule) => capsule.label).join(", ") || "No active capsule"}</small></div>
          <button className="icon-btn" aria-label="Sign out" title="Sign out" onClick={onLogout}><Icon name="signout" /></button>
        </div>
      </aside>
      <main className="main" id="main-content" tabIndex={-1} inert={mobileOpen}>
        {sessionNotice && <div className="alert warning global-alert" role="status"><Icon name="warning" /><span>{sessionNotice}</span><button className="icon-btn" aria-label="Dismiss session warning" onClick={onDismissSessionNotice}><Icon name="close" /></button></div>}
        {error && <div className="alert error global-alert" role="alert"><Icon name="warning" /><span>{error}</span><button className="icon-btn" aria-label="Dismiss error" onClick={() => setError(null)}><Icon name="close" /></button></div>}
        {success && <div className="toast success" role="status"><Icon name="check" /><span>{success}</span><button className="icon-btn" aria-label="Dismiss message" onClick={() => setSuccess(null)}><Icon name="close" /></button></div>}
        {view === "overview" && <Dashboard principal={principal} onError={setError} onSuccess={setSuccess} />}
        {view === "surfaces" && <Surfaces principal={principal} />}
        {view === "data" && <AuthorizedDataView principal={principal} onSwitchAccount={onLogout} />}
        {view === "jit" && <JitPanel principal={principal} admin={admin} onSuccess={setSuccess} />}
        {!admin && view === "request" && <Dashboard principal={principal} variant="role-studio" requestMode="self" onError={setError} onSuccess={setSuccess} />}
        {admin && view === "architecture" && <Architecture principal={principal} />}
        {admin && view === "roles" && <Dashboard principal={principal} variant="role-studio" requestMode="governed" onError={setError} onSuccess={setSuccess} />}
        {reviewer && view === "reviews" && <RoleRequests principal={principal} onSuccess={setSuccess} />}
        {reviewer && view === "recertifications" && <Recertifications principal={principal} admin={admin} onSuccess={setSuccess} />}
        {admin && view === "capsules" && <Capsules onSuccess={setSuccess} />}
        {admin && view === "compiler" && <Compiler />}
        {admin && view === "audit" && <Audit />}
      </main>
    </div>
  );
}

function NavGroup({ label, items, view, onSelect }: { label: string; items: typeof ACCESS_NAV; view: View; onSelect: (view: View) => void }) {
  return (
    <section className="nav-group" aria-labelledby={`nav-${label.toLowerCase()}`}>
      <h2 id={`nav-${label.toLowerCase()}`}>{label}</h2>
      {items.map((item) => (
        <button key={item.id} aria-current={view === item.id ? "page" : undefined} className={view === item.id ? "active" : ""} onClick={() => onSelect(item.id)}>
          <span className="nav-icon"><Icon name={item.icon} /></span>
          <span><b>{item.label}</b><small>{item.detail}</small></span>
        </button>
      ))}
    </section>
  );
}

const ROLE_FAMILIES: Array<{ name: string; label: string; description: string; boundary: string; icon: IconName }> = [
  { name: "Viewer", label: "Business access", description: "Reads only the rows and fields carried by an approved capsule.", boundary: "No operations or policy changes", icon: "user" },
  { name: "Operator", label: "Service operations", description: "Monitors, runs, or retries approved workloads without inheriting raw business data.", boundary: "Operational actions stay separate from data", icon: "activity" },
  { name: "Data steward", label: "Data governance", description: "Owns classification, purpose, and access approval for governed products.", boundary: "Cannot approve their own elevation", icon: "data" },
  { name: "Security auditor", label: "Independent assurance", description: "Reads authorization evidence and explicitly approved cross-team views.", boundary: "Broad visibility is never implicit", icon: "audit" },
  { name: "Platform admin", label: "Control plane", description: "Maintains policies and connectors without automatic access to business records.", boundary: "Administration is not data access", icon: "shield" },
];

const PIPELINE_STAGES: Array<{
  id: string;
  step: string;
  title: string;
  description: string;
  matches: (datasetId: string) => boolean;
}> = [
  { id: "source", step: "01", title: "S/4 source", description: "Restricted system of record", matches: (id) => id.startsWith("s4") },
  { id: "replication", step: "02", title: "BW replication", description: "Process chains and governed analytics", matches: (id) => id.startsWith("bw") || id.startsWith("pc_") || id === "sla" },
  { id: "observability", step: "03", title: "Observability", description: "Technical events isolated from payload", matches: (id) => id.startsWith("es_") },
  { id: "shared", step: "04", title: "Shared data plane", description: "One target, policy-filtered consumers", matches: (id) => id === "warehouse" },
  { id: "consume", step: "05", title: "BI and evidence", description: "Dashboards, reports, and audit", matches: (id) => id === "bobj" || id === "audit" },
];

function Architecture({ principal }: { principal: Principal }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [surfaces, setSurfaces] = useState<Surface[]>([]);
  const [capsuleId, setCapsuleId] = useState("");
  const [policy, setPolicy] = useState<CompiledPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [compiling, setCompiling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compilerError, setCompilerError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const compileGeneration = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    Promise.all([api.catalog(controller.signal), api.explain(controller.signal)])
      .then(([nextCatalog, explained]) => {
        setCatalog(nextCatalog);
        setSurfaces(explained.surfaces);
        const eligible = nextCatalog.capsules.filter((capsule) =>
          capsule.active && nextCatalog.bindings.some((binding) => binding.capsuleId === capsule.id)
        );
        setCapsuleId((current) => eligible.some((capsule) => capsule.id === current) ? current : eligible[0]?.id ?? "");
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to load the architecture model");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [principal.id, refresh]);

  useEffect(() => {
    if (!capsuleId) {
      compileGeneration.current += 1;
      setPolicy(null);
      setCompilerError(null);
      return;
    }
    const generation = ++compileGeneration.current;
    const controller = new AbortController();
    setCompiling(true);
    setPolicy(null);
    setCompilerError(null);
    api.compiler(capsuleId, controller.signal)
      .then((nextPolicy) => {
        if (controller.signal.aborted || generation !== compileGeneration.current) return;
        if (nextPolicy.capsuleId !== capsuleId) {
          setCompilerError(`Compiler returned ${nextPolicy.capsuleId} while ${capsuleId} was selected. The result was rejected.`);
          return;
        }
        setPolicy(nextPolicy);
      })
      .catch((cause) => {
        if (!controller.signal.aborted && generation === compileGeneration.current) setCompilerError(cause instanceof Error ? cause.message : "Unable to generate this enforcement plan");
      })
      .finally(() => { if (!controller.signal.aborted && generation === compileGeneration.current) setCompiling(false); });
    return () => controller.abort();
  }, [capsuleId]);

  const activeCapsules = catalog?.capsules.filter((capsule) =>
    capsule.active && catalog.bindings.some((binding) => binding.capsuleId === capsule.id)
  ) ?? [];
  const selectedCapsule = activeCapsules.find((capsule) => capsule.id === capsuleId);
  const selectedBindings = catalog?.bindings.filter((binding) => binding.capsuleId === capsuleId) ?? [];
  const selectedContractIds = new Set(selectedBindings.map((binding) => binding.contractId));
  const selectedContracts = catalog?.contracts.filter((contract) => selectedContractIds.has(contract.id)) ?? [];
  const selectedDatasetIds = new Set(selectedContracts.map((contract) => contract.datasetId));
  const selectedDatasets = catalog?.datasets.filter((dataset) => selectedDatasetIds.has(dataset.id)) ?? [];
  const blockedGates = policy?.capabilityGates.filter((gate) => gate.status === "blocked").length ?? 0;
  const eligibleGates = policy?.capabilityGates.filter((gate) => gate.status === "eligible").length ?? 0;
  const allowed = surfaces.filter((surface) => surface.effect === "allow").length;
  const compilationBlocked = policy?.deploymentStatus === "blocked";
  const applyOperations = policy?.plan.apply.length ?? 0;
  const readbackChecks = policy?.plan.readback.length ?? 0;

  return (
    <>
      <PageHeader
        eyebrow="Architecture · Operating model"
        title="Portable policy model"
        description="A reference control-plane design for the modeled SAP, BW, Elasticsearch, analytics, and workload-identity estate: few role families, governed scopes, purpose-bound decisions, and fail-closed plans."
        action={<button className="btn secondary" onClick={() => setRefresh((value) => value + 1)}><Icon name="refresh" />Refresh model</button>}
      />
      {error ? <InlineError message={error} onRetry={() => setRefresh((value) => value + 1)} /> : loading || !catalog ? <ArchitectureSkeleton /> : (
        <div className="architecture-page">
          <section className="architecture-hero card" aria-labelledby="architecture-outcome-title">
            <div className="architecture-hero-copy">
              <div className="section-kicker">Executive view</div>
              <h2 id="architecture-outcome-title">Isolate every team without duplicating the data platform</h2>
              <p>People keep a compact capability role. Capsules carry team, tenant, purpose, and lifecycle. Data contracts decide the exact rows, fields, and actions. Removing a capsule closes the central decision path in one operation.</p>
              <div className="architecture-proof"><Icon name="shield" /><span><b>Deny by default</b> A missing identity, purpose, scope, contract, or supported enforcement capability produces no access.</span></div>
            </div>
            <dl className="architecture-metrics" aria-label="Registered control-plane inventory">
              <div><dt>Target role families</dt><dd>5</dd></div>
              <div><dt>Governed products</dt><dd>{catalog.datasets.length}</dd></div>
              <div><dt>Active scopes</dt><dd>{catalog.capsules.filter((capsule) => capsule.active).length}</dd></div>
              <div><dt>Allowed admin surfaces</dt><dd>{allowed}</dd></div>
            </dl>
          </section>

          <section className="architecture-section" aria-labelledby="role-model-title">
            <SectionHeading id="role-model-title" kicker="Universal model" title="Few roles. Precise data boundaries." description="Role families describe capability; capsules and contracts carry the variability that normally causes role explosion." />
            <div className="decision-formula" aria-label="Authorization decision formula">
              <FormulaNode icon="roles" label="Role" value="Capability" />
              <span aria-hidden="true">×</span>
              <FormulaNode icon="capsule" label="Capsule" value="Team + tenant" />
              <span aria-hidden="true">×</span>
              <FormulaNode icon="data" label="Attributes" value="Row + field" />
              <span aria-hidden="true">×</span>
              <FormulaNode icon="key" label="Context" value="Purpose + assurance" />
              <span aria-hidden="true">→</span>
              <FormulaNode icon="shield" label="Decision" value="Allow + obligations" accent />
            </div>
            <div className="role-family-grid">
              {ROLE_FAMILIES.map((role) => (
                <article className="role-family-card" key={role.name}>
                  <span className="card-icon"><Icon name={role.icon} /></span>
                  <div><span className="role-label">{role.label}</span><h3>{role.name}</h3></div>
                  <p>{role.description}</p>
                  <small><Icon name="lock" />{role.boundary}</small>
                </article>
              ))}
            </div>
            <p className="model-disclosure"><Icon name="warning" /><span>The reference data currently contains <b>{catalog.personas.length} implementation personas</b>. The enterprise target is to map them into these five stable human role families; pipeline identities remain separate workloads.</span></p>
          </section>

          <section className="architecture-section" aria-labelledby="lineage-title">
            <SectionHeading id="lineage-title" kicker="Governed data plane" title="Catalog and lineage" description="The scoped catalog is a registered policy inventory for resource identity, declared origin, classification, purpose contracts, and capsule bindings—not a live source-system inventory." />
            <ol className="pipeline-flow" aria-label="S/4 to consumer data lineage">
              {PIPELINE_STAGES.map((stage) => {
                const datasets = catalog.datasets.filter((dataset) => stage.matches(dataset.id));
                const contracts = catalog.contracts.filter((contract) => datasets.some((dataset) => dataset.id === contract.datasetId));
                return (
                  <li key={stage.id}>
                    <span className="pipeline-step">{stage.step}</span>
                    <div className="pipeline-stage-head"><h3>{stage.title}</h3><span>{stage.description}</span></div>
                    <div className="pipeline-products">
                      {datasets.length ? datasets.map((dataset) => <code key={dataset.id}>{dataset.id}</code>) : <span>No registered product</span>}
                    </div>
                    <div className="pipeline-stage-foot"><span>{datasets.length} product{datasets.length === 1 ? "" : "s"}</span><span>{contracts.length} contract{contracts.length === 1 ? "" : "s"}</span></div>
                  </li>
                );
              })}
            </ol>
            <div className="catalog-table table-card">
              <div className="table-head"><div><h2>Governed products</h2><p>Registered policy metadata returned by the scoped catalog API</p></div><span className="secure-chip"><Icon name="data" /> {catalog.datasets.length} registered</span></div>
              <div className="table-wrap"><table><caption>Governed data-product catalog</caption><thead><tr><th scope="col">Data product</th><th scope="col">Origin</th><th scope="col">Classification</th><th scope="col">Purposes</th><th scope="col">Bound scopes</th></tr></thead><tbody>
                {catalog.datasets.map((dataset) => {
                  const contracts = catalog.contracts.filter((contract) => contract.datasetId === dataset.id);
                  const contractIds = new Set(contracts.map((contract) => contract.id));
                  const bindings = catalog.bindings.filter((binding) => contractIds.has(binding.contractId));
                  return <tr key={dataset.id}><td><b>{dataset.name}</b><small className="cell-sub">{dataset.id}</small></td><td>{dataset.origin}</td><td><Classification value={dataset.classification} /></td><td>{[...new Set(contracts.map((contract) => contract.purpose))].map(humanize).join(", ") || "No contract"}</td><td>{bindings.length}</td></tr>;
                })}
              </tbody></table></div>
            </div>
            <p className="model-disclosure"><Icon name="warning" /><span><b>Current boundary:</b> this catalog contains explicitly registered reference metadata. It does not yet crawl SAP, BW, Elastic, ADF, databases, or BI tools, infer ownership, or approve classifications. Enterprise discovery connectors and steward approval remain required.</span></p>
          </section>

          <section className="architecture-section" aria-labelledby="fidelity-title">
            <SectionHeading id="fidelity-title" kicker="Enforcement assurance" title="Generated is not the same as verified" description="The fidelity firewall must refuse any target that cannot preserve row, field, purpose, and action obligations exactly." />
            <div className="fidelity-toolbar card">
              <div className="field"><label htmlFor="architecture-capsule">Inspect capsule</label><select id="architecture-capsule" value={capsuleId} onChange={(event) => setCapsuleId(event.target.value)}>{activeCapsules.map((capsule) => <option key={capsule.id} value={capsule.id}>{capsule.label}</option>)}</select></div>
              <div aria-live="polite"><span>{compiling ? "Loading policy boundary" : "Selected policy boundary"}</span><code>{capsuleId || "No bound capsule"}</code></div>
            </div>
            {selectedCapsule && <CapsulePolicyLens key={`lens-${selectedCapsule.id}`} catalog={catalog} capsule={selectedCapsule} policy={policy} compiling={compiling} />}
            <div className="fidelity-grid" aria-label="Enforcement fidelity states" aria-live="polite">
              <FidelityCard step="01" title="Decide" status={selectedContracts.length ? "Boundary modeled" : "No contracts"} tone={selectedContracts.length ? "verified" : "blocked"} description={`${selectedContracts.length} bound contract${selectedContracts.length === 1 ? "" : "s"} govern ${selectedDatasets.length} product${selectedDatasets.length === 1 ? "" : "s"} for ${selectedCapsule?.label ?? "this capsule"}.`} />
              <FidelityCard step="02" title="Compile" status={compiling ? "Generating" : compilationBlocked ? "Blocked by fidelity" : policy ? "Deployable plan" : "Unavailable"} tone={compilationBlocked ? "blocked" : policy ? "generated" : "blocked"} description={compiling ? `Building a fresh desired state for ${selectedCapsule?.label ?? capsuleId}.` : policy ? `${eligibleGates} eligible and ${blockedGates} blocked native capability checks.` : "No compiler result is available for this boundary."} />
              <FidelityCard step="03" title="Apply" status={compilationBlocked ? "Blocked upstream" : applyOperations ? "Plan ready" : "Connector required"} tone={compilationBlocked ? "blocked" : "pending"} description={compilationBlocked ? "The compiler emitted no apply operations because required controls would be lost." : `${applyOperations} planned upsert operation${applyOperations === 1 ? "" : "s"}; connector execution is not claimed.`} />
              <FidelityCard step="04" title="Read back" status={compilationBlocked ? "Blocked upstream" : readbackChecks ? "Checks planned" : "Not verified"} tone="blocked" description={compilationBlocked ? "There is no deployable state to verify for this capsule." : `${readbackChecks} policy-hash and assignment check${readbackChecks === 1 ? "" : "s"} await target receipts.`} />
              <FidelityCard step="05" title="Reconcile" status="No drift proof" tone="blocked" description={policy ? `Continuous comparison is not connected for policy ${policy.policyVersion}.` : "Continuous comparison requires a compiled policy and connected adapters."} />
            </div>
            {compilerError && <InlineError message={compilerError} />}
            {policy && <CompiledFootprint key={`footprint-${policy.capsuleId}`} policy={policy} capsuleLabel={selectedCapsule?.label ?? policy.capsuleId} />}
          </section>

          <section className="architecture-section developer-contract card" aria-labelledby="developer-contract-title">
            <div>
              <div className="section-kicker">Developer view · selected desired state</div>
              <h2 id="developer-contract-title">One capsule, inspectable enforcement output</h2>
              <p>The implemented <code>POST /access/v1/evaluation</code> endpoint remains the runtime authorization decision. This panel deliberately shows the selected capsule’s compiler output—not a fabricated allow response—so developers can verify contracts, assignments, row filters, and native target names before any connector applies them.</p>
              <ul>
                <li><Icon name="check" /><span>Never infer access from UI visibility.</span></li>
                <li><Icon name="check" /><span>Enforce again at every API, query, export, and operation boundary.</span></li>
                <li><Icon name="check" /><span>Reject unknown or unsupported obligations.</span></li>
              </ul>
            </div>
            <pre aria-label={`Desired-state preview for ${selectedCapsule?.label ?? "selected capsule"}`}>{selectedPolicyPreview(policy, selectedContracts)}</pre>
          </section>
        </div>
      )}
    </>
  );
}

function SectionHeading({ id, kicker, title, description }: { id: string; kicker: string; title: string; description: string }) {
  return <header className="section-heading"><div className="section-kicker">{kicker}</div><h2 id={id}>{title}</h2><p>{description}</p></header>;
}

function FormulaNode({ icon, label, value, accent = false }: { icon: IconName; label: string; value: string; accent?: boolean }) {
  return <div className={`formula-node ${accent ? "accent" : ""}`}><Icon name={icon} /><span><small>{label}</small><b>{value}</b></span></div>;
}

function Classification({ value }: { value: string }) {
  const tone = value.toLowerCase() === "restricted" ? "restricted" : value.toLowerCase() === "confidential" ? "confidential" : "internal";
  return <span className={`classification ${tone}`}><span />{humanize(value)}</span>;
}

function FidelityCard({ step, title, status, tone, description }: { step: string; title: string; status: string; tone: "verified" | "generated" | "pending" | "blocked"; description: string }) {
  return <article className="fidelity-card" data-tone={tone}><div><span>{step}</span><strong>{status}</strong></div><h3>{title}</h3><p>{description}</p></article>;
}

function CapsulePolicyLens({ catalog, capsule, policy, compiling }: {
  catalog: Catalog;
  capsule: Catalog["capsules"][number];
  policy: CompiledPolicy | null;
  compiling: boolean;
}) {
  const bindings = catalog.bindings.filter((binding) => binding.capsuleId === capsule.id);
  const contractIds = new Set(bindings.map((binding) => binding.contractId));
  const contracts = catalog.contracts.filter((contract) => contractIds.has(contract.id));
  const datasetIds = new Set(contracts.map((contract) => contract.datasetId));
  const datasets = catalog.datasets.filter((dataset) => datasetIds.has(dataset.id));
  const members = catalog.memberships.filter((membership) => membership.capsuleId === capsule.id);
  const actions = [...new Set(contracts.flatMap((contract) => contract.actions ?? []))].sort();
  const attributes = Object.entries(capsule.attrs ?? {}).filter(([, value]) =>
    Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== ""
  );
  const blocked = policy?.capabilityGates.filter((gate) => gate.status === "blocked").length ?? 0;
  const eligible = policy?.capabilityGates.filter((gate) => gate.status === "eligible").length ?? 0;

  return (
    <article className={`capsule-policy-lens card ${compiling ? "is-loading" : ""}`} aria-live="polite" aria-busy={compiling}>
      <header className="capsule-lens-head">
        <div className="capsule-lens-identity"><span className="card-icon"><Icon name="capsule" /></span><div><span className="section-kicker">Live policy lens</span><h3>{capsule.label}</h3><code>{capsule.id}</code></div></div>
        <span className={`capsule-state ${compiling ? "pending" : ""}`}><span />{compiling ? "Refreshing compiler output" : capsule.active ? "Active boundary" : "Inactive boundary"}</span>
      </header>
      <dl className="capsule-lens-metrics" aria-label={`${capsule.label} policy inventory`}>
        <div><dt>Purpose</dt><dd>{humanize(capsule.purpose)}</dd></div>
        <div><dt>Assigned identities</dt><dd>{members.length}</dd></div>
        <div><dt>Bound contracts</dt><dd>{contracts.length}</dd></div>
        <div><dt>Governed products</dt><dd>{datasets.length}</dd></div>
        <div><dt>Actions</dt><dd>{actions.map(humanize).join(" · ") || "None"}</dd></div>
      </dl>
      <div className="capsule-lens-detail">
        <section aria-labelledby={`scope-${capsule.id}`}>
          <div className="capsule-lens-title"><span><Icon name="data" /><b id={`scope-${capsule.id}`}>Row-scope attributes</b></span><small>{attributes.length} dimensions</small></div>
          {attributes.length ? <div className="scope-attribute-list">{attributes.map(([name, raw]) => {
            const values = Array.isArray(raw) ? raw : [raw];
            return <div key={name}><span>{humanize(name)}</span><div>{values.map((value, index) => <code key={`${name}-${index}`}>{String(value)}</code>)}</div></div>;
          })}</div> : <p className="lens-empty">No capsule attributes. Contract predicates and identity eligibility still apply.</p>}
        </section>
        <section aria-labelledby={`contracts-${capsule.id}`}>
          <div className="capsule-lens-title"><span><Icon name="audit" /><b id={`contracts-${capsule.id}`}>Bound contract coverage</b></span><small>{eligible} eligible · {blocked} blocked gates</small></div>
          <ul className="capsule-contract-list">{contracts.map((contract) => {
            const dataset = catalog.datasets.find((candidate) => candidate.id === contract.datasetId);
            const allowCount = contract.allowFields?.length ?? dataset?.allowedFields?.length ?? 0;
            return <li key={contract.id}><div><code>{contract.id}</code><span>{dataset?.name ?? contract.datasetId}</span></div><div><span>{(contract.actions ?? []).map(humanize).join(", ") || "No actions"}</span><small>{allowCount} allowed · {contract.denyFields?.length ?? 0} denied fields{contract.approvalRequired ? " · approval required" : ""}</small></div></li>;
          })}</ul>
        </section>
      </div>
      <footer className="capsule-lens-footer">
        <span>Compiled assignments <b>{compiling ? "…" : policy?.assignments.length ?? 0}</b></span>
        <span>Policy version <code>{compiling ? "refreshing" : policy?.policyVersion ?? "unavailable"}</code></span>
        <span>Policy hash <code>{compiling ? "refreshing" : policy ? `${policy.policyHash.slice(0, 16)}…` : "unavailable"}</code></span>
      </footer>
    </article>
  );
}

function CompiledFootprint({ policy, capsuleLabel }: { policy: CompiledPolicy; capsuleLabel: string }) {
  const blocked = policy.capabilityGates.filter((gate) => gate.status === "blocked").length;
  const items = [
    ["Elasticsearch", policy.elasticsearch.length],
    ["SAP BW", policy.bw.length],
    ["BusinessObjects", policy.bobj.groups.length],
    ["Dashboard spaces", policy.dashboards.spaces.length],
    ["Workload identities", policy.adf.identities.length],
  ] as const;
  return <div className="compiled-footprint card"><div><Icon name="code" /><span><b>{capsuleLabel} · {policy.deploymentStatus}</b><small><code>{policy.policyVersion}</code> · {blocked ? `${blocked} capability gate${blocked === 1 ? "" : "s"} blocked deployment. ` : ""}Target application and read-back remain unverified.</small></span></div><ul>{items.map(([label, count]) => <li key={label}><span>{label}</span><b>{count}</b></li>)}</ul></div>;
}

function selectedPolicyPreview(policy: CompiledPolicy | null, contracts: Catalog["contracts"]): string {
  if (!policy) return JSON.stringify({ status: "Select a capsule or wait for compilation" }, null, 2);
  return JSON.stringify({
    kind: "desired-state-preview",
    capsuleId: policy.capsuleId,
    policyVersion: policy.policyVersion,
    policyHash: policy.policyHash,
    deploymentStatus: policy.deploymentStatus,
    contracts: contracts.map((contract) => contract.id),
    assignments: policy.assignments.map(({ principalId, personaId, kind }) => ({ principalId, personaId, kind })),
    nativeArtifacts: {
      elasticsearch: policy.elasticsearch.map((artifact) => ({
        name: artifact.name,
        indices: artifact.indices.map((index) => ({ names: index.names, rowFilter: index.query })),
      })),
      bw: policy.bw.map((artifact) => ({
        name: artifact.name,
        infoProvider: artifact.infoProvider,
        characteristics: artifact.characteristics,
      })),
      businessObjects: policy.bobj.groups,
      dashboardSpaces: policy.dashboards.spaces,
      workloadIdentities: policy.adf.identities,
    },
    capabilityGates: {
      eligible: policy.capabilityGates.filter((gate) => gate.status === "eligible").length,
      blocked: policy.capabilityGates.filter((gate) => gate.status === "blocked").map((gate) => ({
        target: gate.target,
        contractId: gate.contractId,
        missing: gate.missing,
      })),
    },
  }, null, 2);
}

function ArchitectureSkeleton() {
  return <div className="architecture-skeleton" role="status" aria-label="Loading architecture model"><span /><div><span /><span /><span /></div><span /><span /></div>;
}

function Surfaces({ principal }: { principal: Principal }) {
  const [surfaces, setSurfaces] = useState<Surface[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    api.explain(controller.signal)
      .then((result) => setSurfaces(result.surfaces))
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to explain access"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [principal.id, refresh]);
  const allowed = surfaces.filter((surface) => surface.effect === "allow").length;
  return (
    <>
      <PageHeader eyebrow="Decision intelligence" title="Effective access" description={`The current policy decision for ${principal.displayName}, explained from identity through contract and projection.`} action={<button className="btn secondary" onClick={() => setRefresh((value) => value + 1)}><Icon name="refresh" />Refresh decisions</button>} />
      <div className="statrow">
        <MiniStat label="Persona" value={principal.personaLabel ?? principal.personaId} />
        <MiniStat label="Live capsules" value={String(principal.capsules.length)} />
        <MiniStat label="Allowed products" value={String(allowed)} tone="teal" />
        <MiniStat label="Classification ceiling" value={principal.ceiling ?? "None"} />
      </div>
      {error ? <InlineError message={error} onRetry={() => setRefresh((value) => value + 1)} /> : loading ? <TableSkeleton /> : surfaces.length === 0 ? <EmptyState icon="shield" title="No decisions returned" body="The PDP did not return any data-product surfaces for this identity." /> : (
        <div className="table-card">
          <div className="table-head"><div><h2>Data-product decisions</h2><p>{surfaces.length} evaluated surfaces</p></div></div>
          <div className="table-wrap"><table><caption>Effective access decisions for {principal.displayName}</caption><thead><tr><th scope="col">Data product</th><th scope="col">Decision</th><th scope="col">Visible rows</th><th scope="col">Contract</th></tr></thead>
            <tbody>{surfaces.map((surface) => <tr key={surface.datasetId}><td><b>{surface.datasetName}</b><small className="cell-sub">{surface.datasetId}</small></td><td><Status effect={surface.effect} text={decisionLabel(surface.effect, surface.reason)} /></td><td>{surface.rowCount.toLocaleString()}</td><td><code>{surface.contractId ?? "No binding"}</code></td></tr>)}</tbody>
          </table></div>
        </div>
      )}
    </>
  );
}

export function RecordTable({
  rows,
  title = "Projected records",
  subtitle,
  emptyTitle = "No visible records",
  emptyBody = "The PDP denied this request or the authorized capsule slice is empty.",
}: {
  rows: RecordRow[];
  title?: string;
  subtitle?: string;
  emptyTitle?: string;
  emptyBody?: string;
}) {
  const keys = useMemo(() => {
    const set = new Set<string>();
    for (const row of rows) Object.keys(row.attrs).forEach((key) => set.add(key));
    const preferred = ["vendor_id", "vendor_name", "status", "region", "spend", "chain", "occurred_at"];
    return [...set].sort((left, right) => {
      const leftRank = preferred.indexOf(left);
      const rightRank = preferred.indexOf(right);
      if (leftRank === -1 && rightRank === -1) return left.localeCompare(right);
      if (leftRank === -1) return 1;
      if (rightRank === -1) return -1;
      return leftRank - rightRank;
    });
  }, [rows]);
  if (rows.length === 0) return <EmptyState icon="lock" title={emptyTitle} body={emptyBody} />;
  return (
    <div className="table-card"><div className="table-head"><div><h2>{title}</h2><p>{subtitle ?? `${rows.length.toLocaleString()} policy-filtered rows`}</p></div><span className="secure-chip"><Icon name="shield" /> PDP enforced</span></div>
      <div className="table-wrap"><table data-testid="records"><caption>Policy-filtered data records</caption><thead><tr><th scope="col">Record ID</th>{keys.map((key) => <th scope="col" key={key}>{humanize(key)}</th>)}</tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><code>{row.id}</code></td>{keys.map((key) => <td key={key}>{formatValue(row.attrs[key])}</td>)}</tr>)}</tbody></table></div>
    </div>
  );
}

function Capsules({ onSuccess }: { onSuccess: (message: string) => void }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "offboard" | "reset"; id?: string; label: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(null);
    api.catalog(controller.signal).then(setCatalog).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to load capsules"); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refresh]);

  async function execute(cascade = false) {
    if (!confirm) return;
    setWorking(true); setActionError(null);
    try {
      if (confirm.kind === "reset") {
        await api.reset();
        onSuccess("Demo landscape reset to its seeded state.");
      } else if (confirm.id) {
        const result = await api.offboard(confirm.id, cascade);
        onSuccess(`Local desired state updated for ${result.cascaded.length} capsule${result.cascaded.length === 1 ? "" : "s"}; removed ${result.removedMembers.length} membership${result.removedMembers.length === 1 ? "" : "s"}, ${result.removedBindings.length} binding${result.removedBindings.length === 1 ? "" : "s"}, and expired ${result.expiredJit.length} JIT grant${result.expiredJit.length === 1 ? "" : "s"}.`);
      }
      setConfirm(null); setRefresh((value) => value + 1);
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : "Lifecycle action failed"); }
    finally { setWorking(false); }
  }

  return (
    <>
      <PageHeader eyebrow="Governance · Lifecycle" title="Capsule lifecycle" description="Capsules are the atomic join, move, and leave boundary. Review impact before revoking memberships and native bindings." action={catalog?.features?.demoReset ? <button className="btn danger-outline" onClick={() => { setActionError(null); setConfirm({ kind: "reset", label: "entire demo landscape" }); }}><Icon name="refresh" />Reset demo</button> : undefined} />
      {error ? <InlineError message={error} onRetry={() => setRefresh((value) => value + 1)} /> : loading ? <TableSkeleton /> : !catalog?.capsules.length ? <EmptyState icon="capsule" title="No capsules" body="No lifecycle units are registered in the catalog." /> : (
        <div className="card-grid capsules-grid">{catalog.capsules.map((capsule) => {
          const members = catalog.memberships.filter((membership) => membership.capsuleId === capsule.id);
          return <article className="capsule-card" key={capsule.id}><div className="capsule-card-top"><span className="capsule-icon"><Icon name="capsule" /></span><Status effect={capsule.active ? "allow" : "deny"} text={capsule.active ? "Live" : "Offboarded"} /></div><h2>{capsule.label}</h2><p>{humanize(capsule.purpose)}</p><dl><div><dt>Members</dt><dd>{members.length}</dd></div><div><dt>Capsule ID</dt><dd><code>{capsule.id}</code></dd></div></dl>{capsule.active && capsule.id !== "control-plane" && <button className="btn danger-outline full" onClick={() => { setActionError(null); setConfirm({ kind: "offboard", id: capsule.id, label: capsule.label }); }}><Icon name="warning" />Review offboarding</button>}</article>;
        })}</div>
      )}
      {confirm?.kind === "reset" && <ConfirmDialog title="Reset the entire demo landscape?" body="This replaces all personas, capsules, memberships, contracts, JIT grants, and audit events with seeded demo data." confirmLabel="Reset landscape" requiredPhrase="RESET" working={working} error={actionError} destructive onCancel={() => setConfirm(null)} onConfirm={() => void execute()} />}
      {confirm?.kind === "offboard" && confirm.id && catalog && <OffboardDialog catalog={catalog} capsuleId={confirm.id} working={working} error={actionError} onClose={() => setConfirm(null)} onConfirm={(cascade) => void execute(cascade)} />}
    </>
  );
}

function JitPanel({ principal, admin, onSuccess }: { principal: Principal; admin: boolean; onSuccess: (message: string) => void }) {
  const [grants, setGrants] = useState<JitGrant[]>([]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [optionKey, setOptionKey] = useState("");
  const [justification, setJustification] = useState("");
  const [ticket, setTicket] = useState("");
  const [durationMs, setDurationMs] = useState(3_600_000);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<number | undefined>();
  const [total, setTotal] = useState(0);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [denyTarget, setDenyTarget] = useState<JitGrant | null>(null);
  const [denyError, setDenyError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<JitGrant | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const justificationId = useId();
  const ticketId = useId();
  const jitOptions = useMemo(() => {
    if (!catalog) return [];
    return catalog.bindings.flatMap((binding) => {
      const contract = catalog.contracts.find((candidate) => candidate.id === binding.contractId);
      const capsule = catalog.capsules.find((candidate) => candidate.id === binding.capsuleId);
      const dataset = contract ? catalog.datasets.find((candidate) => candidate.id === contract.datasetId) : undefined;
      if (!contract?.approvalRequired || !capsule?.active || !dataset) return [];
      return [{ key: binding.id, binding, contract, capsule, dataset }];
    });
  }, [catalog]);
  const selectedOption = jitOptions.find((option) => option.key === optionKey) ?? jitOptions[0];

  useEffect(() => {
    if (jitOptions.length && !jitOptions.some((option) => option.key === optionKey)) setOptionKey(jitOptions[0]!.key);
  }, [jitOptions, optionKey]);

  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(null);
    Promise.all([api.jitList({ limit: EVIDENCE_PAGE_SIZE }, controller.signal), admin ? Promise.resolve(null) : api.catalog(controller.signal)])
      .then(([result, nextCatalog]) => {
        setGrants(result.grants);
        setNextCursor(result.nextCursor);
        setTotal(result.total);
        if (nextCatalog) setCatalog(nextCatalog);
      })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to load JIT requests"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [admin, principal.id, refresh]);

  async function requestAccess(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedOption || justification.trim().length < 12) { setError("Choose an approved elevation profile and provide a justification of at least 12 characters."); return; }
    setWorking("request"); setError(null);
    try {
      const grant = await api.jitRequest({
        datasetId: selectedOption.dataset.id,
        capsuleId: selectedOption.capsule.id,
        contractId: selectedOption.contract.id,
        purpose: selectedOption.contract.purpose,
        justification: justification.trim(),
        durationMs,
        ...(ticket.trim() ? { ticket: ticket.trim() } : {}),
      });
      setGrants((current) => [grant, ...current.filter((item) => item.id !== grant.id)]);
      setTotal((current) => current + (grants.some((item) => item.id === grant.id) ? 0 : 1));
      setJustification(""); setTicket(""); onSuccess(`JIT request ${grant.id} submitted with a frozen ${grant.policyVersion} scope.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to submit JIT request"); }
    finally { setWorking(null); }
  }

  async function approve(grant: JitGrant) {
    const approvedTtl = grant.requestContext?.requestedTtlMs ?? grant.requestedTtlMs ?? durationMs;
    setWorking(grant.id); setError(null);
    try { await api.jitApprove(grant.id, approvedTtl); onSuccess(`JIT request ${grant.id} approved with a ${formatDuration(approvedTtl)} TTL.`); setRefresh((value) => value + 1); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to approve JIT request"); }
    finally { setWorking(null); }
  }

  async function revoke(reason: string) {
    if (!revokeTarget) return;
    setWorking(`revoke:${revokeTarget.id}`); setRevokeError(null);
    try {
      const revoked = await api.jitRevoke(revokeTarget.id, reason);
      setGrants((current) => current.map((grant) => grant.id === revoked.id ? revoked : grant));
      onSuccess(`JIT request ${revoked.id} revoked immediately.`);
      setRevokeTarget(null);
    } catch (cause) { setRevokeError(cause instanceof Error ? cause.message : "Unable to revoke JIT access"); }
    finally { setWorking(null); }
  }

  async function deny(reason: string) {
    if (!denyTarget) return;
    setWorking(`deny:${denyTarget.id}`); setDenyError(null);
    try {
      const denied = await api.jitDeny(denyTarget.id, reason);
      setGrants((current) => current.map((grant) => grant.id === denied.id ? denied : grant));
      onSuccess(`JIT request ${denied.id} denied; no temporary access was activated.`);
      setDenyTarget(null);
    } catch (cause) { setDenyError(cause instanceof Error ? cause.message : "Unable to deny JIT request"); }
    finally { setWorking(null); }
  }

  async function loadMore() {
    if (nextCursor === undefined || loadingMore) return;
    setLoadingMore(true); setError(null);
    try {
      const result = await api.jitList({ cursor: nextCursor, limit: EVIDENCE_PAGE_SIZE });
      setGrants((current) => {
        const existing = new Set(current.map((grant) => grant.id));
        return [...current, ...result.grants.filter((grant) => !existing.has(grant.id))];
      });
      setNextCursor(result.nextCursor);
      setTotal(result.total);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load more JIT requests"); }
    finally { setLoadingMore(false); }
  }

  const visibleGrants = admin ? grants : grants.filter((grant) => grant.principalId === principal.id || grant.requesterId === principal.id);
  return (
    <>
      <PageHeader eyebrow="Time-bound elevation" title={admin ? "JIT approval queue" : "Request JIT access"} description={admin ? "Review independently requested elevation without creating standing administrator access." : "Restricted access is scoped, justified, dual-controlled, and automatically expires. Standing privilege is never created."} />
      <div className={`jit-layout ${admin ? "approval-only" : ""}`}>
        {!admin && <form className="card jit-form" onSubmit={requestAccess}>
          <div className="card-title"><span className="card-icon amber"><Icon name="key" /></span><div><h2>New elevation request</h2><p>Select a predeclared contract; free-form data elevation is not permitted.</p></div></div>
          {jitOptions.length ? <>
            <div className="field full-field"><label htmlFor="jit-profile">Approved elevation profile</label><select id="jit-profile" value={selectedOption?.key ?? ""} onChange={(event) => setOptionKey(event.target.value)}>{jitOptions.map((option) => <option key={option.key} value={option.key}>{option.dataset.name} · {option.capsule.label} · {humanize(option.contract.purpose)}</option>)}</select><small>Dataset, capsule, purpose, actions, rows, and fields come from one governed contract.</small></div>
            {selectedOption && <JitContractPreview option={selectedOption} principal={principal} />}
            <div className="field full-field"><label htmlFor={justificationId}>Operational justification</label><textarea id={justificationId} rows={4} placeholder="Explain why standing access is insufficient" value={justification} onChange={(event) => setJustification(event.target.value)} aria-describedby={`${justificationId}-hint`} /><small id={`${justificationId}-hint`}>Minimum 12 characters. This becomes part of the immutable request context.</small></div>
            <div className="field"><label htmlFor={ticketId}>Incident or change ticket <span className="muted">(optional)</span></label><input id={ticketId} value={ticket} onChange={(event) => setTicket(event.target.value)} placeholder="INC-10482" /></div>
            <div className="field"><label htmlFor="jit-duration">Maximum duration</label><select id="jit-duration" value={durationMs} onChange={(event) => setDurationMs(Number(event.target.value))}><option value={900_000}>15 minutes</option><option value={3_600_000}>1 hour</option><option value={14_400_000}>4 hours</option></select><small>An approver may shorten, never extend, this TTL.</small></div>
            <button className="btn primary full" disabled={working === "request"}><Icon name="key" />{working === "request" ? "Submitting…" : "Submit frozen scope for approval"}</button>
          </> : <div className="jit-no-profile"><Icon name="lock" /><div><b>No elevation profile is assigned</b><p>A data steward must bind an approval-required contract to one of your active capsules before you can request JIT access.</p></div></div>}
        </form>}
        <section className="card jit-assurance" aria-labelledby="jit-assurance-title"><div className="card-title"><span className="card-icon"><Icon name="shield" /></span><div><h2 id="jit-assurance-title">Guardrails</h2><p>Controls applied to every elevation.</p></div></div><ul className="assurance-list"><li><Icon name="check" /><span><b>Dual control</b>Requester cannot approve.</span></li><li><Icon name="check" /><span><b>Frozen contract</b>Policy edits cannot widen a live grant.</span></li><li><Icon name="check" /><span><b>Row and field scope</b>Predicate, allowlist, masks, and ceiling travel together.</span></li><li><Icon name="check" /><span><b>Expiry and revoke</b>TTL is capped and access can be killed immediately.</span></li><li><Icon name="check" /><span><b>Audit evidence</b>Policy version and lifecycle actors are recorded.</span></li></ul></section>
      </div>
      {error && <InlineError message={error} onRetry={() => setRefresh((value) => value + 1)} />}
      <section className="table-card"><div className="table-head"><div><h2>{admin ? "Approval queue" : "My recent requests"}</h2><p>{admin ? "Pending requests require an independent administrator." : "Requests submitted by you, including earlier sessions."}</p>{total > 0 && <small className="loaded-summary">Showing {visibleGrants.length} of {total}.</small>}</div><button className="btn secondary" onClick={() => setRefresh((value) => value + 1)}><Icon name="refresh" />Refresh</button></div>
        {loading ? <TableSkeleton embedded /> : visibleGrants.length === 0 ? <EmptyState compact icon="key" title="No JIT requests" body={admin ? "The approval queue is clear." : "Submit a request to begin dual-control review."} /> : (
          <div className="table-wrap">
            <table>
              <caption>Just-in-time access requests</caption>
              <thead><tr><th scope="col">Request / principal</th><th scope="col">Contract boundary</th><th scope="col">Frozen scope</th><th scope="col">Lifecycle</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>{visibleGrants.map((grant) => (
                <tr key={grant.id}>
                  <td><code>{grant.id}</code><small className="cell-sub">{grant.principalId} · requested by {grant.requesterId}</small></td>
                  <td><b>{grant.datasetId}</b><small className="cell-sub">{grant.contractId} · {humanize(grant.purpose)}</small></td>
                  <td><JitScopeDetails grant={grant} /></td>
                  <td><Status effect={grant.status === "approved" ? "allow" : grant.status === "pending" ? "pending" : "deny"} text={humanize(grant.status)} /><small className="cell-sub">{jitLifecycleText(grant)}</small></td>
                  <td className="actions-cell jit-actions">{admin && grant.status === "pending" && <><button className="btn small primary" disabled={Boolean(working)} onClick={() => void approve(grant)}>{working === grant.id ? "Approving…" : "Approve"}</button><button className="btn small danger-outline" disabled={Boolean(working)} onClick={() => { setDenyError(null); setDenyTarget(grant); }}>Deny</button></>}{((admin && grant.status === "approved") || (!admin && grant.requesterId === principal.id && (grant.status === "pending" || grant.status === "approved"))) && <button className="btn small danger-outline" disabled={Boolean(working)} onClick={() => { setRevokeError(null); setRevokeTarget(grant); }}>Revoke</button>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {!loading && visibleGrants.length > 0 && <EvidencePager loaded={visibleGrants.length} total={total} hasMore={nextCursor !== undefined} loading={loadingMore} onLoadMore={() => void loadMore()} label="JIT requests" />}
      </section>
      {denyTarget && <JitDenyDialog grant={denyTarget} working={working === `deny:${denyTarget.id}`} error={denyError} onClose={() => setDenyTarget(null)} onConfirm={deny} />}
      {revokeTarget && <JitRevokeDialog grant={revokeTarget} working={working === `revoke:${revokeTarget.id}`} error={revokeError} onClose={() => setRevokeTarget(null)} onConfirm={revoke} />}
    </>
  );
}

function JitContractPreview({ option, principal }: { option: { contract: Catalog["contracts"][number]; capsule: Catalog["capsules"][number]; dataset: Catalog["datasets"][number] }; principal: Principal }) {
  const fields = option.contract.allowFields ?? option.dataset.allowedFields ?? [];
  const actions = option.contract.actions?.filter((action) => principal.actions.includes(action)) ?? [];
  const ceiling = lowerClassification(principal.ceiling, option.contract.classificationMax ?? option.dataset.classification);
  return <section className="jit-contract-preview" aria-label="Selected JIT contract boundary"><div className="jit-contract-head"><span><Icon name="shield" /> Pre-submission boundary</span><code>{option.contract.id}</code></div><dl><div><dt>Dataset</dt><dd>{option.dataset.name}</dd></div><div><dt>Capsule</dt><dd>{option.capsule.label}</dd></div><div><dt>Effective actions</dt><dd>{actions.map(humanize).join(", ") || "None"}</dd></div><div><dt>Effective ceiling</dt><dd>{humanize(ceiling)}</dd></div><div><dt>Allowed fields</dt><dd>{fields.join(", ") || "Resolved by server"}</dd></div><div><dt>Required masks</dt><dd>{option.contract.denyFields?.join(", ") || "None"}<small>Global JIT masks are added server-side.</small></dd></div></dl><p><Icon name="lock" /><span>Row scope: <code>{predicateLabel(option.contract.predicate)}</code>. The server freezes the final intersection; the approver reviews that exact snapshot.</span></p></section>;
}

function JitScopeDetails({ grant }: { grant: JitGrant }) {
  return <details className="jit-scope-detail"><summary>Inspect exact scope</summary><dl><div><dt>Actions</dt><dd>{grant.actions.map(humanize).join(", ")}</dd></div><div><dt>Ceiling</dt><dd>{humanize(grant.classificationMax)}</dd></div><div><dt>Allowed</dt><dd>{grant.allowedFields.join(", ")}</dd></div><div><dt>Masked</dt><dd>{grant.denyFields.join(", ") || "None"}</dd></div><div><dt>Rows</dt><dd><code>{predicateLabel(grant.predicate)}</code></dd></div><div><dt>Policy</dt><dd><code>{grant.policyVersion}</code></dd></div>{grant.requestContext.ticket && <div><dt>Ticket</dt><dd>{grant.requestContext.ticket}</dd></div>}</dl></details>;
}

function predicateLabel(predicate?: Record<string, unknown>): string {
  if (!predicate) return "Resolved and frozen by server";
  if (predicate.op === "true") return "All contract-authorized rows";
  if (predicate.op === "fromCapsuleAttr") return `${String(predicate.field ?? "field")} ∈ capsule.${String(predicate.attr ?? "scope")}`;
  if (predicate.op === "eq") return `${String(predicate.field ?? "field")} = ${String(predicate.value ?? "value")}`;
  return JSON.stringify(predicate);
}

function lowerClassification(left = "none", right = "none"): string {
  const rank: Record<string, number> = { none: 0, internal: 1, confidential: 2, restricted: 3 };
  return (rank[left] ?? 0) <= (rank[right] ?? 0) ? left : right;
}

function jitLifecycleText(grant: JitGrant): string {
  if (grant.status === "denied") {
    const decision = `Denied ${formatDate(grant.deniedAt)} by ${grant.deniedBy ?? "authorized reviewer"}`;
    return grant.denialReason ? `${decision} · ${grant.denialReason}` : decision;
  }
  if (grant.status === "revoked") return `Revoked ${formatDate(grant.revokedAt)} by ${grant.revokedBy ?? "authorized actor"}`;
  if (grant.expiresAt) return `Expires ${formatDate(grant.expiresAt)}`;
  return `Requested ${formatDate(grant.createdAt)} · ${formatDuration(grant.requestContext?.requestedTtlMs ?? grant.requestedTtlMs ?? 0)} max`;
}

function RoleRequests({ principal, onSuccess }: { principal: Principal; onSuccess: (message: string) => void }) {
  const [requests, setRequests] = useState<RoleRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<number | undefined>();
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<RoleRequest | null>(null);
  const [working, setWorking] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [decisionSodViolations, setDecisionSodViolations] = useState<SodViolation[]>([]);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(null);
    api.roleRequests({ limit: EVIDENCE_PAGE_SIZE }, controller.signal).then((result) => {
      setRequests(result.requests);
      setNextCursor(result.nextCursor);
      setTotal(result.total);
    }).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to load access reviews"); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refresh]);

  async function loadMore() {
    if (nextCursor === undefined || loadingMore) return;
    setLoadingMore(true); setError(null);
    try {
      const result = await api.roleRequests({ cursor: nextCursor, limit: EVIDENCE_PAGE_SIZE });
      setRequests((current) => {
        const existing = new Set(current.map((request) => request.id));
        return [...current, ...result.requests.filter((request) => !existing.has(request.id))];
      });
      setNextCursor(result.nextCursor);
      setTotal(result.total);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load more access reviews"); }
    finally { setLoadingMore(false); }
  }

  const reviewerRole = governanceReviewerRole(principal);

  async function decide(decision: "approve" | "deny", reason = "") {
    if (!selected) return; setWorking(true); setDecisionError(null); setDecisionSodViolations([]);
    try {
      const result = decision === "approve" ? await api.approveRoleRequest(selected.id) : await api.denyRoleRequest(selected.id, reason);
      if (decision === "deny") {
        onSuccess(`${result.id} denied. No access was applied.`);
      } else if (result.status === "approved" && result.applied) {
        onSuccess(`Both approvals are complete. Access was applied to ${result.applied.capsuleId}.`);
      } else {
        const completed = completedApprovalRoles(result).length;
        onSuccess(`${reviewerRole ? reviewerRoleLabel(reviewerRole) : "Reviewer"} approval recorded; ${completed} of ${result.requiredApprovals.length} complete. No access was applied.`);
      }
      setSelected(null); setDecisionError(null); setRefresh((value) => value + 1);
    } catch (cause) {
      setDecisionSodViolations(sodViolationsFromApiError(cause));
      setDecisionError(cause instanceof Error ? cause.message : "Unable to complete review");
    }
    finally { setWorking(false); }
  }

  const pending = requests.filter((request) => request.status === "pending");
  return (
    <>
      <PageHeader eyebrow="Governance · Two-role approval" title="Access reviews" description="Every request needs one Data Owner approval and one Governance Admin approval. The frozen policy is applied only after both independent decisions are recorded." action={<button className="btn secondary" onClick={() => setRefresh((value) => value + 1)}><Icon name="refresh" />Refresh queue</button>} />
      <div className="statrow"><MiniStat label="Pending loaded" value={String(pending.length)} tone={pending.length ? "amber" : "teal"} /><MiniStat label="Approved loaded" value={String(requests.filter((request) => request.status === "approved").length)} /><MiniStat label="Denied loaded" value={String(requests.filter((request) => request.status === "denied").length)} /><MiniStat label="Total requests" value={String(total)} /></div>
      {error ? <InlineError message={error} onRetry={() => setRefresh((value) => value + 1)} /> : loading ? <TableSkeleton /> : requests.length === 0 ? <EmptyState icon="check" title="Review queue is clear" body="New role requests will appear here for independent approval." /> : (
        <div className="table-card">
          <div className="table-wrap">
            <table>
              <caption>Role access requests</caption>
              <thead><tr><th scope="col">Request</th><th scope="col">Target</th><th scope="col">Role / purpose</th><th scope="col">Scope</th><th scope="col">Approval progress</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>{requests.map((request) => {
                const actorAlreadyDecided = reviewerRole ? request.approvals.some((approval) => approval.reviewerRole === reviewerRole) : true;
                const selfBlocked = request.requesterId === principal.id || request.principalId === principal.id;
                return <tr key={request.id}>
                  <td><code>{request.id}</code><small className="cell-sub">{formatDate(request.createdAt)} · policy v{request.approvalPolicyVersion}</small></td>
                  <td>{request.principalId}<small className="cell-sub">Requested by {request.requesterId}</small></td>
                  <td><b>{request.draft.name}</b><small className="cell-sub">{humanize(request.draft.purpose)}</small></td>
                  <td>{request.draft.products.length} products<small className="cell-sub">{request.draft.tenants.join(", ") || "All tenants"}</small></td>
                  <td><ApprovalProgress request={request} /></td>
                  <td className="actions-cell">{request.status !== "pending" ? <span className="muted">Decided</span> : selfBlocked ? <span className="muted">Independent reviewer required</span> : actorAlreadyDecided ? <span className="muted">Your decision is recorded</span> : <button className="btn small secondary" onClick={() => { setDecisionError(null); setDecisionSodViolations([]); setSelected(request); }}>Review</button>}</td>
                </tr>;
              })}</tbody>
            </table>
          </div>
          <EvidencePager loaded={requests.length} total={total} hasMore={nextCursor !== undefined} loading={loadingMore} onLoadMore={() => void loadMore()} label="role requests" />
        </div>
      )}
      {selected && reviewerRole && <RequestReviewDialog request={selected} reviewerRole={reviewerRole} working={working} error={decisionError} sodViolations={decisionSodViolations} onClose={() => setSelected(null)} onDecide={decide} />}
    </>
  );
}

function Compiler() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [capsuleId, setCapsuleId] = useState("");
  const [policy, setPolicy] = useState<CompiledPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api.catalog(controller.signal).then((result) => {
      setCatalog(result);
      setCapsuleId((current) => current || result.capsules.find((capsule) =>
        capsule.active && result.bindings.some((binding) => binding.capsuleId === capsule.id)
      )?.id || result.capsules.find((capsule) => capsule.active)?.id || "");
    }).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to load compiler catalog"); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!capsuleId) return;
    const controller = new AbortController(); setLoading(true); setError(null); setPolicy(null);
    api.compiler(capsuleId, controller.signal).then(setPolicy).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to compile native policy"); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [capsuleId]);
  return (
    <>
      <PageHeader eyebrow="Governance · Enforcement" title="Native policy compiler" description="Inspect the enforcement plan generated from one contract across Elasticsearch, BW, BOBJ, dashboards, and workload identity." action={<div className="purpose-control"><label htmlFor="compiler-capsule">Capsule</label><select id="compiler-capsule" value={capsuleId} onChange={(event) => setCapsuleId(event.target.value)}>{catalog?.capsules.filter((capsule) => capsule.active).map((capsule) => <option key={capsule.id} value={capsule.id}>{capsule.label}</option>)}</select></div>} />
      {error ? <InlineError message={error} /> : loading ? <PolicySkeleton /> : policy ? <PolicySummary policy={policy} /> : <EmptyState icon="code" title="No compiled policy" body="Select an active capsule to inspect its native enforcement plan." />}
    </>
  );
}

function Audit() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<number | undefined>();
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(null);
    api.audit({ limit: EVIDENCE_PAGE_SIZE }, controller.signal).then((result) => {
      setEvents(result.events);
      setNextCursor(result.nextCursor);
      setTotal(result.total);
    }).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to load audit evidence"); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refresh]);
  async function loadMore() {
    if (nextCursor === undefined || loadingMore) return;
    setLoadingMore(true); setError(null);
    try {
      const result = await api.audit({ cursor: nextCursor, limit: EVIDENCE_PAGE_SIZE });
      setEvents((current) => {
        const existing = new Set(current.map((event) => event.seq));
        return [...current, ...result.events.filter((event) => !existing.has(event.seq))];
      });
      setNextCursor(result.nextCursor);
      setTotal(result.total);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load more audit evidence"); }
    finally { setLoadingMore(false); }
  }
  const filtered = events.filter((event) =>
    `${event.seq} ${event.type} ${event.actorId} ${event.hash} ${JSON.stringify(event.detail ?? {})}`
      .toLowerCase()
      .includes(query.toLowerCase())
  );
  return (
    <>
      <PageHeader eyebrow="Governance · Evidence" title="Hash-chained audit" description="Search loaded local authorization evidence and inspect chain identifiers used to detect in-store tampering. External retention and anchoring require a production adapter." action={<button className="btn secondary" onClick={() => setRefresh((value) => value + 1)}><Icon name="refresh" />Refresh evidence</button>} />
      <div className="audit-toolbar card"><label className="search-field"><span className="sr-only">Search loaded audit events</span><Icon name="search" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search actor, event type, sequence, or hash (loaded)" /></label><span className="secure-chip"><Icon name="shield" /> {events.length} of {total} loaded</span></div>
      {error ? <InlineError message={error} onRetry={() => setRefresh((value) => value + 1)} /> : loading ? <TableSkeleton /> : filtered.length === 0 ? <EmptyState icon="audit" title="No matching evidence" body={query ? "Try a broader audit search." : "No audit events have been recorded."} /> : <div className="audit-list">{filtered.map((event) => <details className="audit-event" key={event.seq}><summary><span className="audit-seq">#{event.seq}</span><span className="audit-type"><b>{humanize(event.type)}</b><small>{event.actorId} · {formatDate(event.at)}</small></span><Status effect="allow" text="Chained" /><code>{event.hash.slice(0, 14)}…</code><Icon name="chevron" /></summary><div className="audit-detail"><dl><div><dt>Full hash</dt><dd><code>{event.hash}</code></dd></div>{event.prevHash && <div><dt>Previous hash</dt><dd><code>{event.prevHash}</code></dd></div>}</dl>{event.detail && <pre>{JSON.stringify(event.detail, null, 2)}</pre>}</div></details>)}</div>}
      {!loading && events.length > 0 && <EvidencePager loaded={events.length} total={total} hasMore={nextCursor !== undefined} loading={loadingMore} onLoadMore={() => void loadMore()} label="audit events" />}
    </>
  );
}

function PolicySummary({ policy }: { policy: CompiledPolicy }) {
  const cards = [
    { name: "Elasticsearch", count: policy.elasticsearch.length, detail: "DLS/FLS roles", icon: "search" as IconName },
    { name: "SAP BW", count: policy.bw.length, detail: "Analysis authorizations", icon: "data" as IconName },
    { name: "BusinessObjects", count: policy.bobj.groups.length, detail: "Groups and folders", icon: "roles" as IconName },
    { name: "Dashboards", count: policy.dashboards.spaces.length, detail: "Authorized spaces", icon: "activity" as IconName },
    { name: "Workload identity", count: policy.adf.identities.length, detail: "SPIFFE identities", icon: "key" as IconName },
  ];
  return (
    <><div className="compiler-status card"><div><span className="status-dot" /><div><b>Compilation successful</b><small>Plan generated locally; deployment and drift status require connected enforcement adapters.</small></div></div><code>{String(policy.capsuleId ?? "capsule")}</code></div><div className="connector-grid">{cards.map((card) => <article className="connector-card" key={card.name}><span className="card-icon"><Icon name={card.icon} /></span><div><h2>{card.name}</h2><p>{card.detail}</p></div><b>{card.count}</b></article>)}</div><details className="raw-policy card"><summary><Icon name="code" />Inspect generated policy JSON</summary><pre>{JSON.stringify(policy, null, 2)}</pre></details></>
  );
}

function capsuleDescendants(catalog: Catalog, capsuleId: string) {
  const descendants: Catalog["capsules"] = [];
  const visited = new Set([capsuleId]);
  const queue = [capsuleId];
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    for (const capsule of catalog.capsules) {
      if (capsule.parentId !== parentId || visited.has(capsule.id)) continue;
      visited.add(capsule.id);
      descendants.push(capsule);
      queue.push(capsule.id);
    }
  }
  return descendants;
}

function OffboardDialog({ catalog, capsuleId, working, error, onClose, onConfirm }: { catalog: Catalog; capsuleId: string; working: boolean; error: string | null; onClose: () => void; onConfirm: (cascade: boolean) => void }) {
  const titleId = useId();
  const cascadeId = useId();
  const [cascade, setCascade] = useState(false);
  const modalRef = useModalFocus<HTMLElement>(onClose, working);
  const capsule = catalog.capsules.find((candidate) => candidate.id === capsuleId);
  const descendants = capsuleDescendants(catalog, capsuleId);
  const targetIds = new Set([capsuleId, ...(cascade ? descendants.map((candidate) => candidate.id) : [])]);
  const targets = catalog.capsules.filter((candidate) => targetIds.has(candidate.id));
  const memberships = catalog.memberships.filter((membership) => targetIds.has(membership.capsuleId));
  const principals = new Set(memberships.map((membership) => membership.principalId));
  const bindings = catalog.bindings.filter((binding) => targetIds.has(binding.capsuleId));
  return <div className="modal-backdrop"><section ref={modalRef} className="modal offboard-modal" role="alertdialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}><div className="modal-icon danger"><Icon name="warning" /></div><div className="eyebrow">Desired-state blast radius</div><h2 id={titleId}>Offboard {capsule?.label ?? capsuleId}?</h2><p className="lead">This changes the local control-plane desired state. It does not claim that SAP, Elasticsearch, BI, or other external targets were updated or read back.</p>{descendants.length > 0 && <label className="cascade-option" htmlFor={cascadeId}><input id={cascadeId} type="checkbox" checked={cascade} onChange={(event) => setCascade(event.target.checked)} /><span><b>Include {descendants.length} descendant capsule{descendants.length === 1 ? "" : "s"}</b><small>{cascade ? "The root and every descendant are included." : "Only the selected capsule will be offboarded."}</small></span></label>}<div className="blast-grid" aria-label="Offboarding blast radius"><div><span>Capsules</span><b>{targets.length}</b></div><div><span>Membership records</span><b>{memberships.length}</b></div><div><span>Unique people</span><b>{principals.size}</b></div><div><span>Contract bindings</span><b>{bindings.length}</b></div></div><div className="blast-capsules"><span>Included boundary</span>{targets.map((target) => <code key={target.id}>{target.label}</code>)}</div><div className="local-state-note"><Icon name="code" /><span><b>What execution does here</b>Removes the catalog memberships and bindings above, expires matching local JIT grants, and produces native revoke plans. Connected adapters must apply and verify those plans separately.</span></div>{error && <div className="dialog-error" role="alert"><Icon name="warning" /><span>{error}</span></div>}<div className="modal-actions"><button data-autofocus className="btn secondary" disabled={working} onClick={onClose}>Keep current state</button><button className="btn danger" disabled={working} onClick={() => onConfirm(cascade)}>{working ? "Updating desired state…" : `Offboard ${targets.length} capsule${targets.length === 1 ? "" : "s"}`}</button></div></section></div>;
}

function ApprovalProgress({ request, expanded = false }: { request: RoleRequest; expanded?: boolean }) {
  const completed = completedApprovalRoles(request);
  return <div className={`approval-progress ${expanded ? "expanded" : ""}`} aria-label={`${completed.length} of ${request.requiredApprovals.length} approvals complete`}>
    <div className="approval-progress-label"><b>{completed.length} of {request.requiredApprovals.length}</b><span>{request.status === "approved" ? "Applied" : request.status === "denied" ? "Denied" : "Awaiting approvals"}</span></div>
    <div className="approval-role-row">{request.requiredApprovals.map((role) => {
      const approval = request.approvals.find((item) => item.reviewerRole === role);
      return <span key={role} className={`approval-role ${approval?.decision ?? "pending"}`} title={approval ? `${approval.decision} by ${approval.reviewerId}` : `${reviewerRoleLabel(role)} pending`}><Icon name={approval?.decision === "denied" ? "close" : approval?.decision === "approved" ? "check" : "lock"} />{reviewerRoleLabel(role)}</span>;
    })}</div>
  </div>;
}

function completedApprovalRoles(request: RoleRequest): GovernanceReviewerRole[] {
  return request.requiredApprovals.filter((role) => request.approvals.some((approval) => approval.reviewerRole === role && approval.decision === "approved"));
}

function RequestReviewDialog({ request, reviewerRole, working, error, sodViolations, onClose, onDecide }: { request: RoleRequest; reviewerRole: GovernanceReviewerRole; working: boolean; error: string | null; sodViolations: SodViolation[]; onClose: () => void; onDecide: (decision: "approve" | "deny", reason?: string) => void }) {
  const titleId = useId();
  const [reason, setReason] = useState("");
  const modalRef = useModalFocus<HTMLElement>(onClose, working);
  return <div className="modal-backdrop"><section ref={modalRef} className="modal role-review-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
    <div className="modal-icon"><Icon name="check" /></div>
    <div className="eyebrow">{reviewerRoleLabel(reviewerRole)} decision · policy v{request.approvalPolicyVersion}</div>
    <h2 id={titleId}>{request.draft.name}</h2>
    <p className="lead">Requested for <b>{request.principalId}</b> by {request.requesterId}. Your decision is independent and permanently recorded.</p>
    <ApprovalProgress request={request} expanded />
    <div className="approval-assurance"><Icon name="lock" /><span><b>No early application</b>The role remains pending until both required reviewer roles approve the exact same frozen request. A denial closes it without changing access.</span></div>
    <dl className="review-grid"><div><dt>Actions</dt><dd>{request.draft.verbs.join(", ") || "None"}</dd></div><div><dt>Purpose</dt><dd>{humanize(request.draft.purpose)}</dd></div><div><dt>Ceiling</dt><dd>{humanize(request.draft.ceiling)}</dd></div><div><dt>Products</dt><dd>{request.draft.products.map(humanize).join(", ") || "None"}</dd></div><div><dt>Tenants</dt><dd>{request.draft.tenants.join(", ") || "All tenants"}</dd></div><div><dt>Regions</dt><dd>{request.draft.regions.join(", ") || "All regions"}</dd></div><div><dt>Departments</dt><dd>{request.draft.departments.join(", ") || "All departments"}</dd></div><div><dt>Sources</dt><dd>{request.draft.sources.map(humanize).join(", ") || "All sources"}</dd></div><div><dt>Protected fields</dt><dd>{request.draft.denyFields.join(", ") || "None"}</dd></div></dl>
    {request.approvals.length > 0 && <section className="recorded-decisions" aria-label="Recorded decisions"><b>Recorded decisions</b>{request.approvals.map((approval) => <div key={`${approval.reviewerRole}-${approval.reviewerId}`}><span className={`decision-mark ${approval.decision}`}><Icon name={approval.decision === "approved" ? "check" : "close"} /></span><span><b>{reviewerRoleLabel(approval.reviewerRole)}</b><small>{approval.decision} by {approval.reviewerId} · {formatDate(approval.decidedAt)}{approval.reason ? ` · ${approval.reason}` : ""}</small></span></div>)}</section>}
    <div className="field"><label htmlFor="review-reason">Decision reason <span className="muted">(required to deny)</span></label><textarea id="review-reason" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Record the evidence behind this decision" /></div>
    {sodViolations.length > 0 && <section className="review-sod-findings" role="alert" aria-label="Approval separation of duties findings"><b>Approval blocked by current SoD policy</b>{sodViolations.map((violation) => <article key={`${violation.ruleId}-${violation.ruleVersion}`}><code>{violation.ruleId}@{violation.ruleVersion}</code><h3>{violation.title}</h3><p>{violation.rationale}</p><span><b>Remediation:</b> {violation.remediation}</span></article>)}</section>}
    {error && <div className="dialog-error" role="alert"><Icon name="warning" /><span>{error}</span></div>}
    <div className="modal-actions split"><button data-autofocus className="btn secondary" disabled={working} onClick={onClose}>Cancel</button><button className="btn danger-outline" disabled={working || reason.trim().length < 3} onClick={() => onDecide("deny", reason.trim())}>Deny request</button><button className="btn primary" disabled={working || sodViolations.length > 0} onClick={() => onDecide("approve", reason.trim())}><Icon name="check" />{working ? "Recording…" : `Record ${reviewerRoleLabel(reviewerRole)} approval`}</button></div>
  </section></div>;
}

function JitDenyDialog({ grant, working, error, onClose, onConfirm }: { grant: JitGrant; working: boolean; error: string | null; onClose: () => void; onConfirm: (reason: string) => void }) {
  const titleId = useId();
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const modalRef = useModalFocus<HTMLElement>(onClose, working);
  return <div className="modal-backdrop"><section ref={modalRef} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}><div className="modal-icon danger"><Icon name="warning" /></div><div className="eyebrow">Independent JIT decision</div><h2 id={titleId}>Deny {grant.id}?</h2><p className="lead">The request for <b>{grant.principalId}</b> remains visible as denied, with the reviewer and reason recorded. No temporary access is activated.</p><dl className="review-grid"><div><dt>Contract</dt><dd>{grant.contractId}</dd></div><div><dt>Dataset</dt><dd>{grant.datasetId}</dd></div><div><dt>Purpose</dt><dd>{humanize(grant.purpose)}</dd></div><div><dt>Requested TTL</dt><dd>{formatDuration(grant.requestContext?.requestedTtlMs ?? grant.requestedTtlMs ?? 0)}</dd></div></dl><div className="field"><label htmlFor={reasonId}>Denial reason</label><textarea id={reasonId} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Explain why this temporary elevation is not approved" aria-describedby={`${reasonId}-hint`} /><small id={`${reasonId}-hint`}>Required. The requester will see this outcome and reason.</small></div>{error && <div className="dialog-error" role="alert"><Icon name="warning" /><span>{error}</span></div>}<div className="modal-actions"><button data-autofocus className="btn secondary" disabled={working} onClick={onClose}>Return to review</button><button className="btn danger" disabled={working || reason.trim().length < 8} onClick={() => onConfirm(reason.trim())}>{working ? "Denying…" : "Deny request"}</button></div></section></div>;
}

function JitRevokeDialog({ grant, working, error, onClose, onConfirm }: { grant: JitGrant; working: boolean; error: string | null; onClose: () => void; onConfirm: (reason: string) => void }) {
  const titleId = useId();
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const modalRef = useModalFocus<HTMLElement>(onClose, working);
  return <div className="modal-backdrop"><section ref={modalRef} className="modal" role="alertdialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}><div className="modal-icon danger"><Icon name="warning" /></div><div className="eyebrow">Immediate authorization kill</div><h2 id={titleId}>Revoke {grant.id}?</h2><p className="lead">This closes the grant for <b>{grant.principalId}</b> immediately. It does not remove their standing capsule membership.</p><dl className="review-grid"><div><dt>Contract</dt><dd>{grant.contractId}</dd></div><div><dt>Dataset</dt><dd>{grant.datasetId}</dd></div><div><dt>Purpose</dt><dd>{humanize(grant.purpose)}</dd></div><div><dt>Policy version</dt><dd><code>{grant.policyVersion}</code></dd></div></dl><div className="field"><label htmlFor={reasonId}>Revocation reason</label><textarea id={reasonId} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Incident resolved, request withdrawn, or risk detected" aria-describedby={`${reasonId}-hint`} /><small id={`${reasonId}-hint`}>Required. The reason and actor are written to the audit trail.</small></div>{error && <div className="dialog-error" role="alert"><Icon name="warning" /><span>{error}</span></div>}<div className="modal-actions"><button data-autofocus className="btn secondary" disabled={working} onClick={onClose}>Keep grant</button><button className="btn danger" disabled={working || reason.trim().length < 8} onClick={() => onConfirm(reason.trim())}>{working ? "Revoking…" : "Revoke immediately"}</button></div></section></div>;
}

function ConfirmDialog({ title, body, confirmLabel, requiredPhrase, working, error, destructive, onCancel, onConfirm }: { title: string; body: string; confirmLabel: string; requiredPhrase?: string; working: boolean; error?: string | null; destructive?: boolean; onCancel: () => void; onConfirm: () => void }) {
  const titleId = useId(); const inputId = useId(); const [phrase, setPhrase] = useState("");
  const modalRef = useModalFocus<HTMLElement>(onCancel, working);
  const ready = !requiredPhrase || phrase === requiredPhrase;
  return <div className="modal-backdrop"><section ref={modalRef} className="modal" role="alertdialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}><div className={`modal-icon ${destructive ? "danger" : ""}`}><Icon name="warning" /></div><div className="eyebrow">Impact confirmation</div><h2 id={titleId}>{title}</h2><p className="lead">{body}</p>{requiredPhrase && <div className="field"><label htmlFor={inputId}>Type <code>{requiredPhrase}</code> to confirm</label><input id={inputId} value={phrase} onChange={(event) => setPhrase(event.target.value)} autoComplete="off" /></div>}{error && <div className="dialog-error" role="alert"><Icon name="warning" /><span>{error}</span></div>}<div className="modal-actions"><button data-autofocus className="btn secondary" disabled={working} onClick={onCancel}>Keep current state</button><button className={destructive ? "btn danger" : "btn primary"} disabled={working || !ready} onClick={onConfirm}>{working ? "Applying change…" : confirmLabel}</button></div></section></div>;
}

function EvidencePager({ loaded, total, hasMore, loading, onLoadMore, label }: { loaded: number; total: number; hasMore: boolean; loading: boolean; onLoadMore: () => void; label: string }) {
  return <nav className="evidence-pagination" aria-label={`${humanize(label)} pagination`}><span>Showing <b>{loaded}</b> of <b>{total}</b> {label}</span>{hasMore ? <button className="btn secondary small" disabled={loading} onClick={onLoadMore}>{loading ? "Loading…" : "Load more"}</button> : <span className="pagination-complete"><Icon name="check" />All available records loaded</span>}</nav>;
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return <header className="page-head"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p className="lead">{description}</p></div>{action && <div className="page-actions">{action}</div>}</header>;
}
function MiniStat({ label, value, tone = "" }: { label: string; value: string; tone?: string }) { return <div className={`stat simple ${tone}`}><div><b>{value}</b><span>{label}</span></div></div>; }
function Status({ effect, text }: { effect: "allow" | "deny" | "pending"; text: string }) { return <span className={`status ${effect}`}><span />{text}</span>; }
function InlineError({ message, onRetry }: { message: string; onRetry?: () => void }) { return <div className="inline-state error" role="alert"><Icon name="warning" /><div><h2>Something needs attention</h2><p>{message}</p>{onRetry && <button className="btn secondary small" onClick={onRetry}><Icon name="refresh" />Try again</button>}</div></div>; }
function EmptyState({ icon, title, body, compact = false }: { icon: IconName; title: string; body: string; compact?: boolean }) { return <div className={`empty-state ${compact ? "compact" : "card"}`}><Icon name={icon} /><h2>{title}</h2><p>{body}</p></div>; }
function TableSkeleton({ embedded = false }: { embedded?: boolean }) { return <div className={`table-skeleton ${embedded ? "embedded" : "card"}`} role="status" aria-label="Loading table"><span /><span /><span /><span /></div>; }
function PolicySkeleton() { return <div className="connector-grid policy-skeleton" role="status" aria-label="Compiling native policy">{[0, 1, 2, 3, 4].map((item) => <span key={item} />)}</div>; }

function isAdmin(principal: Principal) {
  return principal.personaId === "admin"
    && principal.capsules.some((capsule) => capsule.id === "control-plane");
}
function isDataOwner(principal: Principal) {
  return principal.personaId === "data-owner"
    && principal.capsules.some((capsule) => capsule.id === "data-governance-owner");
}
function governanceReviewerRole(principal: Principal): GovernanceReviewerRole | undefined {
  if (isAdmin(principal)) return "governance-admin";
  if (isDataOwner(principal)) return "data-owner";
  return undefined;
}
function reviewerRoleLabel(role: GovernanceReviewerRole) {
  return role === "data-owner" ? "Data Owner" : "Governance Admin";
}
function sodViolationsFromApiError(error: unknown): SodViolation[] {
  if (!(error instanceof ApiError) || error.code !== "sod_policy_violation") return [];
  const details = error.details && typeof error.details === "object" ? error.details as { violations?: unknown } : undefined;
  if (!Array.isArray(details?.violations)) return [];
  return details.violations.filter((item): item is SodViolation => Boolean(
    item && typeof item === "object" && typeof (item as SodViolation).ruleId === "string",
  ));
}
function viewFromHash(allowed: View[]): View {
  const candidate = window.location.hash.replace(/^#\/?/, "") as View;
  return allowed.includes(candidate) ? candidate : (allowed[0] ?? "overview");
}
function navigate(view: View, setView: (view: View) => void) {
  const hash = `#/${view}`;
  if (window.location.hash === hash) setView(view); else window.location.hash = hash;
}
function initials(value: string) { return value.split(/[.\s_-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join(""); }
function humanize(value: string) { return value.replaceAll("_", " ").replaceAll(".", " ").replace(/\b\w/g, (character) => character.toUpperCase()); }
function formatValue(value: unknown) { if (value === undefined || value === null || value === "") return <span className="muted">Not available</span>; if (typeof value === "number") return value.toLocaleString(); return typeof value === "object" ? JSON.stringify(value) : String(value); }
function formatDate(value?: number | string) { if (value === undefined) return "Time unavailable"; const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString(); }
function formatDuration(ms: number) {
  if (ms < 3_600_000) { const minutes = Math.round(ms / 60_000); return `${minutes} minute${minutes === 1 ? "" : "s"}`; }
  const hours = ms / 3_600_000; return `${hours} hour${hours === 1 ? "" : "s"}`;
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
