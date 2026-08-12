import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  Edit3,
  Plus,
  RefreshCw,
  ShieldAlert,
  UserRoundPlus,
  X,
} from "lucide-react";
import MossSelect from "@/components/ui/MossSelect";
import {
  PreparationConversationService,
  ReviewedCaseStateService,
  isHighImpactStatement,
  type CaseParty,
  type CaseStatement,
  type CaseStatementKind,
  type ClaimState,
  type CommitmentDetail,
  type DeadlineDetail,
  type PreparationConversation,
} from "@/lib/preparation";

interface ReviewedStatePanelProps {
  caseId: string;
  onRevisionChange: () => Promise<void>;
}

interface StatementForm {
  id?: string;
  revision?: number;
  kind: CaseStatementKind;
  content: string;
  claimState: ClaimState;
  allowedUses: string;
  allowedWording: string;
  jurisdiction: string;
  commitmentPromisorPartyId: string;
  commitmentBeneficiaryPartyId: string;
  commitmentAction: string;
  commitmentConditions: string;
  commitmentCertainty: CommitmentDetail["certainty"];
  commitmentLifecycle: CommitmentDetail["lifecycle"];
  deadlineLinkedStatementId: string;
  deadlineOriginalPhrase: string;
  deadlinePrecision: DeadlineDetail["precision"];
  deadlineDayKind: NonNullable<DeadlineDetail["dayKind"]>;
  deadlineTimezone: string;
  deadlineAnchorDate: string;
  deadlineResolvedDate: string;
}

interface PartyForm {
  displayName: string;
  role: CaseParty["role"];
  organization: string;
}

const STATEMENT_KIND_OPTIONS: CaseStatementKind[] = [
  "objective", "fact", "claim", "unknown", "risk", "commitment",
  "deadline", "reference-number", "action",
];
const CLAIM_STATE_OPTIONS: ClaimState[] = ["asserted", "supported", "disputed", "unknown", "stale"];
const PARTY_ROLES: CaseParty["role"][] = ["user", "counterparty", "representative", "third-party", "unknown"];
const COMMITMENT_CERTAINTIES: CommitmentDetail["certainty"][] = ["explicit", "conditional", "ambiguous"];
const COMMITMENT_LIFECYCLES: CommitmentDetail["lifecycle"][] = ["pending-confirmation", "active", "fulfilled", "missed", "disputed", "superseded", "cancelled"];
const DEADLINE_PRECISIONS: DeadlineDetail["precision"][] = ["exact", "range", "relative", "unknown"];
const DEADLINE_DAY_KINDS: NonNullable<DeadlineDetail["dayKind"]>[] = ["calendar", "business", "unspecified"];

const blankStatement = (): StatementForm => ({
  kind: "fact",
  content: "",
  claimState: "asserted",
  allowedUses: "call-preparation",
  allowedWording: "",
  jurisdiction: "",
  commitmentPromisorPartyId: "",
  commitmentBeneficiaryPartyId: "",
  commitmentAction: "",
  commitmentConditions: "",
  commitmentCertainty: "explicit",
  commitmentLifecycle: "pending-confirmation",
  deadlineLinkedStatementId: "",
  deadlineOriginalPhrase: "",
  deadlinePrecision: "unknown",
  deadlineDayKind: "unspecified",
  deadlineTimezone: "",
  deadlineAnchorDate: "",
  deadlineResolvedDate: "",
});

const editStatementForm = (statement: CaseStatement): StatementForm => ({
  id: statement.id,
  revision: statement.revision,
  kind: statement.kind,
  content: statement.content,
  claimState: statement.claimState,
  allowedUses: statement.allowedUses.join("\n"),
  allowedWording: statement.allowedWording ?? "",
  jurisdiction: statement.jurisdiction ?? "",
  commitmentPromisorPartyId: statement.commitmentDetail?.promisorPartyId ?? "",
  commitmentBeneficiaryPartyId: statement.commitmentDetail?.beneficiaryPartyId ?? "",
  commitmentAction: statement.commitmentDetail?.action ?? "",
  commitmentConditions: statement.commitmentDetail?.conditions.join("\n") ?? "",
  commitmentCertainty: statement.commitmentDetail?.certainty ?? "explicit",
  commitmentLifecycle: statement.commitmentDetail?.lifecycle ?? "pending-confirmation",
  deadlineLinkedStatementId: statement.deadlineDetail?.linkedStatementId ?? "",
  deadlineOriginalPhrase: statement.deadlineDetail?.originalPhrase ?? "",
  deadlinePrecision: statement.deadlineDetail?.precision ?? "unknown",
  deadlineDayKind: statement.deadlineDetail?.dayKind ?? "unspecified",
  deadlineTimezone: statement.deadlineDetail?.timezone ?? "",
  deadlineAnchorDate: statement.deadlineDetail?.anchorDate ?? "",
  deadlineResolvedDate: statement.deadlineDetail?.resolvedDate ?? "",
});

const lines = (value: string) => value.split("\n").map((item) => item.trim()).filter(Boolean);

export default function ReviewedStatePanel({ caseId, onRevisionChange }: ReviewedStatePanelProps) {
  const [service, setService] = useState<ReviewedCaseStateService | null>(null);
  const [statements, setStatements] = useState<CaseStatement[]>([]);
  const [parties, setParties] = useState<CaseParty[]>([]);
  const [conversations, setConversations] = useState<PreparationConversation[]>([]);
  const [conversationId, setConversationId] = useState("");
  const [statementForm, setStatementForm] = useState<StatementForm | null>(null);
  const [partyForm, setPartyForm] = useState<PartyForm | null>(null);
  const [selectedStatement, setSelectedStatement] = useState<CaseStatement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (owner: ReviewedCaseStateService) => {
    const [nextStatements, nextParties] = await Promise.all([
      owner.listStatements(caseId),
      owner.listParties(caseId),
    ]);
    setStatements(nextStatements);
    setParties(nextParties);
    setSelectedStatement((current) => current
      ? nextStatements.find((item) => item.id === current.id) ?? null
      : null);
  }, [caseId]);

  useEffect(() => {
    let active = true;
    void Promise.all([ReviewedCaseStateService.open(), PreparationConversationService.open()])
      .then(async ([owner, conversationsOwner]) => {
        if (!active) return;
        setService(owner);
        await refresh(owner);
        const nextConversations = await conversationsOwner.list(caseId);
        if (!active) return;
        setConversations(nextConversations);
        setConversationId(nextConversations[0]?.id ?? "");
      })
      .catch((reason) => active && setError(String(reason)));
    return () => { active = false; };
  }, [caseId, refresh]);

  const run = async (operation: () => Promise<void>) => {
    if (!service) return;
    setBusy(true);
    setError(null);
    try {
      await operation();
      await refresh(service);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveStatement = () => {
    if (!service || !statementForm) return;
    void run(async () => {
      const commitmentDetail: CommitmentDetail | undefined =
        statementForm.kind === "commitment" &&
        statementForm.commitmentPromisorPartyId &&
        statementForm.commitmentAction.trim()
          ? {
            promisorPartyId: statementForm.commitmentPromisorPartyId,
            beneficiaryPartyId: statementForm.commitmentBeneficiaryPartyId || undefined,
            action: statementForm.commitmentAction.trim(),
            conditions: lines(statementForm.commitmentConditions),
            certainty: statementForm.commitmentCertainty,
            lifecycle: statementForm.commitmentLifecycle,
          }
          : undefined;
      const deadlineDetail: DeadlineDetail | undefined =
        statementForm.kind === "deadline" &&
        statementForm.deadlineLinkedStatementId &&
        statementForm.deadlineOriginalPhrase.trim()
          ? {
            linkedStatementId: statementForm.deadlineLinkedStatementId,
            originalPhrase: statementForm.deadlineOriginalPhrase.trim(),
            precision: statementForm.deadlinePrecision,
            dayKind: statementForm.deadlineDayKind,
            timezone: statementForm.deadlineTimezone.trim() || undefined,
            anchorDate: statementForm.deadlineAnchorDate || undefined,
            resolvedDate: statementForm.deadlineResolvedDate || undefined,
          }
          : undefined;
      if (statementForm.id && statementForm.revision) {
        await service.editStatement({
          statementId: statementForm.id,
          expectedRevision: statementForm.revision,
          kind: statementForm.kind,
          content: statementForm.content,
          claimState: statementForm.claimState,
          allowedUses: lines(statementForm.allowedUses),
          allowedWording: statementForm.allowedWording,
          jurisdiction: statementForm.jurisdiction,
          commitmentDetail,
          deadlineDetail,
        });
      } else {
        await service.createManualStatement({
          caseId,
          kind: statementForm.kind,
          content: statementForm.content,
          claimState: statementForm.claimState,
          allowedUses: lines(statementForm.allowedUses),
          allowedWording: statementForm.allowedWording,
          jurisdiction: statementForm.jurisdiction,
          commitmentDetail,
          deadlineDetail,
        });
      }
      setStatementForm(null);
    });
  };

  const grouped = useMemo(() => ({
    proposals: statements.filter((item) => item.reviewState === "proposed" || item.reviewState === "rejected"),
    confirmed: statements.filter((item) => item.reviewState === "confirmed" && !["commitment", "deadline", "action"].includes(item.kind)),
    commitments: statements.filter((item) => item.reviewState === "confirmed" && ["commitment", "deadline"].includes(item.kind)),
    actions: statements.filter((item) => item.reviewState === "confirmed" && item.kind === "action"),
  }), [statements]);

  const statementRows = (items: CaseStatement[]) => items.length ? items.map((statement) => (
    <button type="button" className="reviewed-statement" key={statement.id} onClick={() => setSelectedStatement(statement)}>
      <span className={`reviewed-kind ${statement.kind}`}>{statement.kind}</span>
      <span><strong>{statement.content}</strong><small>{statement.claimState} · source {statement.sourceStatus} · {statement.sourceRefs.length} refs · revision {statement.revision}</small></span>
      {isHighImpactStatement(statement.kind) && statement.sourceRefs.length === 0 ? <ShieldAlert size={15} /> : <ChevronDown size={15} />}
    </button>
  )) : <p className="reviewed-empty">No items in this group.</p>;

  return <section className="reviewed-state">
    <header className="case-section-toolbar">
      <div><h3>Reviewed Case State</h3><p>Models propose. Human commands create authoritative revisions.</p></div>
      <div>
        <MossSelect ariaLabel="Conversation source" value={conversationId} onValueChange={setConversationId} options={[{ value: "", label: "Choose conversation" }, ...conversations.map((conversation) => ({ value: conversation.id, label: conversation.title }))]} />
        <button type="button" disabled={busy || !conversationId} onClick={() => {
          const conversation = conversations.find((item) => item.id === conversationId);
          if (!service || !conversation) return;
          void run(async () => { await service.proposeFromConversation(conversation); });
        }}><RefreshCw size={14} /> Propose</button>
        <button type="button" onClick={() => setPartyForm({ displayName: "", role: "counterparty", organization: "" })}><UserRoundPlus size={14} /> Party</button>
        <button type="button" onClick={() => setStatementForm(blankStatement())}><Plus size={14} /> Statement</button>
      </div>
    </header>
    {error ? <div className="case-inline-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}><X size={13} /></button></div> : null}
    <div className="reviewed-grid">
      <section><header><h4>Proposals</h4><span>{grouped.proposals.length}</span></header>{statementRows(grouped.proposals)}</section>
      <section><header><h4>Confirmed state</h4><span>{grouped.confirmed.length}</span></header>{statementRows(grouped.confirmed)}</section>
      <section><header><h4>Commitments and deadlines</h4><span>{grouped.commitments.length}</span></header>{statementRows(grouped.commitments)}</section>
      <section><header><h4>Next actions</h4><span>{grouped.actions.length}</span></header>{statementRows(grouped.actions)}</section>
      <section className="reviewed-parties"><header><h4>Parties</h4><span>{parties.length}</span></header>{parties.length ? parties.map((party) => <article key={party.id}><strong>{party.displayName}</strong><small>{party.role}{party.organization ? ` · ${party.organization}` : ""}</small></article>) : <p className="reviewed-empty">No confirmed parties.</p>}</section>
    </div>

    {selectedStatement ? <div className="reviewed-inspector">
      <header><div><span>{selectedStatement.kind} · {selectedStatement.reviewState}</span><h3>{selectedStatement.content}</h3></div><button type="button" onClick={() => setSelectedStatement(null)}><X size={15} /></button></header>
      <dl><div><dt>Claim state</dt><dd>{selectedStatement.claimState}</dd></div><div><dt>Source status</dt><dd>{selectedStatement.sourceStatus}{selectedStatement.sourceStaleReasons.length ? ` · ${selectedStatement.sourceStaleReasons.join(", ")}` : ""}</dd></div><div><dt>Allowed uses</dt><dd>{selectedStatement.allowedUses.join(", ") || "None"}</dd></div><div><dt>Allowed wording</dt><dd>{selectedStatement.allowedWording || "Not constrained"}</dd></div><div><dt>Jurisdiction</dt><dd>{selectedStatement.jurisdiction || "Not specified"}</dd></div></dl>
      {selectedStatement.commitmentDetail ? <section><h4>Commitment detail</h4><p>Promisor: {selectedStatement.commitmentDetail.promisorPartyId}</p><p>Beneficiary: {selectedStatement.commitmentDetail.beneficiaryPartyId || "Not specified"}</p><p>Action: {selectedStatement.commitmentDetail.action}</p><p>Conditions: {selectedStatement.commitmentDetail.conditions.join("; ") || "None"}</p><p>{selectedStatement.commitmentDetail.certainty} · {selectedStatement.commitmentDetail.lifecycle}</p></section> : null}
      {selectedStatement.deadlineDetail ? <section><h4>Deadline detail</h4><p>Linked statement: {selectedStatement.deadlineDetail.linkedStatementId}</p><p>Original phrase: {selectedStatement.deadlineDetail.originalPhrase}</p><p>{selectedStatement.deadlineDetail.precision} · {selectedStatement.deadlineDetail.dayKind || "unspecified"} · {selectedStatement.deadlineDetail.timezone || "timezone unknown"}</p><p>Anchor: {selectedStatement.deadlineDetail.anchorDate || "None"} · Resolved: {selectedStatement.deadlineDetail.resolvedDate || "None"}</p></section> : null}
      <section><h4>Recoverable sources</h4>{selectedStatement.sourceRefs.length ? selectedStatement.sourceRefs.map((source) => <article key={source.id}><strong>{source.sourceKind} · {source.sourceId}</strong><p>{source.quotedText || source.contentHash}</p></article>) : <p className="reviewed-empty">No source. High-impact confirmation will be rejected.</p>}</section>
      <footer>
        {(selectedStatement.reviewState === "proposed" || selectedStatement.reviewState === "rejected") ? <><button type="button" onClick={() => setStatementForm(editStatementForm(selectedStatement))}><Edit3 size={13} /> Edit</button><button type="button" className="danger" disabled={busy} onClick={() => void run(async () => { await service?.rejectStatement(selectedStatement.id, selectedStatement.revision); })}>Reject</button><button type="button" className="primary" disabled={busy} onClick={() => void run(async () => { await service?.confirmStatement(selectedStatement.id, selectedStatement.revision); await onRevisionChange(); })}><Check size={13} /> Confirm</button></> : <button type="button" className="danger" disabled={busy} onClick={() => void run(async () => { await service?.supersedeStatement(selectedStatement.id, selectedStatement.revision); await onRevisionChange(); })}>Supersede</button>}
      </footer>
    </div> : null}

    {statementForm ? <div className="case-modal-layer"><section className="case-modal wide" role="dialog" aria-modal="true">
      <header><div><span>Reviewable statement</span><h2>{statementForm.id ? "Edit proposal" : "Add statement proposal"}</h2></div><button type="button" onClick={() => setStatementForm(null)}><X size={17} /></button></header>
      <div className="case-form-row"><label>Kind<MossSelect ariaLabel="Statement kind" value={statementForm.kind} onValueChange={(kind) => setStatementForm({ ...statementForm, kind: kind as CaseStatementKind })} options={STATEMENT_KIND_OPTIONS.map((kind) => ({ value: kind, label: kind }))} /></label><label>Claim state<MossSelect ariaLabel="Claim state" value={statementForm.claimState} onValueChange={(claimState) => setStatementForm({ ...statementForm, claimState: claimState as ClaimState })} options={CLAIM_STATE_OPTIONS.map((state) => ({ value: state, label: state }))} /></label></div>
      <label>Content<textarea autoFocus value={statementForm.content} onChange={(event) => setStatementForm({ ...statementForm, content: event.target.value })} /></label>
      {statementForm.kind === "commitment" ? <>
        <div className="case-form-row"><label>Promisor<MossSelect ariaLabel="Commitment promisor" value={statementForm.commitmentPromisorPartyId} onValueChange={(value) => setStatementForm({ ...statementForm, commitmentPromisorPartyId: value })} options={[{ value: "", label: "Choose confirmed party" }, ...parties.map((party) => ({ value: party.id, label: party.displayName }))]} /></label><label>Beneficiary<MossSelect ariaLabel="Commitment beneficiary" value={statementForm.commitmentBeneficiaryPartyId} onValueChange={(value) => setStatementForm({ ...statementForm, commitmentBeneficiaryPartyId: value })} options={[{ value: "", label: "Not specified" }, ...parties.map((party) => ({ value: party.id, label: party.displayName }))]} /></label></div>
        <label>Committed action<textarea value={statementForm.commitmentAction} onChange={(event) => setStatementForm({ ...statementForm, commitmentAction: event.target.value })} /></label>
        <label>Conditions<textarea value={statementForm.commitmentConditions} onChange={(event) => setStatementForm({ ...statementForm, commitmentConditions: event.target.value })} placeholder="One per line" /></label>
        <div className="case-form-row"><label>Certainty<MossSelect ariaLabel="Commitment certainty" value={statementForm.commitmentCertainty} onValueChange={(value) => setStatementForm({ ...statementForm, commitmentCertainty: value as CommitmentDetail["certainty"] })} options={COMMITMENT_CERTAINTIES.map((value) => ({ value, label: value }))} /></label><label>Lifecycle<MossSelect ariaLabel="Commitment lifecycle" value={statementForm.commitmentLifecycle} onValueChange={(value) => setStatementForm({ ...statementForm, commitmentLifecycle: value as CommitmentDetail["lifecycle"] })} options={COMMITMENT_LIFECYCLES.map((value) => ({ value, label: value }))} /></label></div>
      </> : null}
      {statementForm.kind === "deadline" ? <>
        <label>Linked commitment or action<MossSelect ariaLabel="Deadline linked statement" value={statementForm.deadlineLinkedStatementId} onValueChange={(value) => setStatementForm({ ...statementForm, deadlineLinkedStatementId: value })} options={[{ value: "", label: "Choose confirmed item" }, ...statements.filter((item) => item.reviewState === "confirmed" && ["commitment", "action"].includes(item.kind)).map((item) => ({ value: item.id, label: item.content }))]} /></label>
        <label>Original deadline phrase<input value={statementForm.deadlineOriginalPhrase} onChange={(event) => setStatementForm({ ...statementForm, deadlineOriginalPhrase: event.target.value })} /></label>
        <div className="case-form-row"><label>Precision<MossSelect ariaLabel="Deadline precision" value={statementForm.deadlinePrecision} onValueChange={(value) => setStatementForm({ ...statementForm, deadlinePrecision: value as DeadlineDetail["precision"] })} options={DEADLINE_PRECISIONS.map((value) => ({ value, label: value }))} /></label><label>Day kind<MossSelect ariaLabel="Deadline day kind" value={statementForm.deadlineDayKind} onValueChange={(value) => setStatementForm({ ...statementForm, deadlineDayKind: value as NonNullable<DeadlineDetail["dayKind"]> })} options={DEADLINE_DAY_KINDS.map((value) => ({ value, label: value }))} /></label></div>
        <div className="case-form-row"><label>Timezone<input value={statementForm.deadlineTimezone} onChange={(event) => setStatementForm({ ...statementForm, deadlineTimezone: event.target.value })} placeholder="America/Los_Angeles" /></label><label>Anchor date<input type="date" value={statementForm.deadlineAnchorDate} onChange={(event) => setStatementForm({ ...statementForm, deadlineAnchorDate: event.target.value })} /></label><label>Resolved date<input type="date" value={statementForm.deadlineResolvedDate} onChange={(event) => setStatementForm({ ...statementForm, deadlineResolvedDate: event.target.value })} /></label></div>
      </> : null}
      <div className="case-form-row thirds statement-constraints"><label>Allowed uses<textarea value={statementForm.allowedUses} onChange={(event) => setStatementForm({ ...statementForm, allowedUses: event.target.value })} placeholder="One per line" /></label><label>Allowed wording<textarea value={statementForm.allowedWording} onChange={(event) => setStatementForm({ ...statementForm, allowedWording: event.target.value })} /></label><label>Jurisdiction<textarea value={statementForm.jurisdiction} onChange={(event) => setStatementForm({ ...statementForm, jurisdiction: event.target.value })} /></label></div>
      <footer><button type="button" className="secondary" onClick={() => setStatementForm(null)}>Cancel</button><button type="button" disabled={busy} onClick={saveStatement}>Save proposal</button></footer>
    </section></div> : null}

    {partyForm ? <div className="case-modal-layer"><section className="case-modal" role="dialog" aria-modal="true">
      <header><div><span>Case party</span><h2>Add a confirmed party</h2></div><button type="button" onClick={() => setPartyForm(null)}><X size={17} /></button></header>
      <label>Name<input autoFocus value={partyForm.displayName} onChange={(event) => setPartyForm({ ...partyForm, displayName: event.target.value })} /></label>
      <label>Role<MossSelect ariaLabel="Party role" value={partyForm.role} onValueChange={(role) => setPartyForm({ ...partyForm, role: role as CaseParty["role"] })} options={PARTY_ROLES.map((role) => ({ value: role, label: role }))} /></label>
      <label>Organization<input value={partyForm.organization} onChange={(event) => setPartyForm({ ...partyForm, organization: event.target.value })} /></label>
      <footer><button type="button" className="secondary" onClick={() => setPartyForm(null)}>Cancel</button><button type="button" disabled={busy} onClick={() => { if (!service) return; void run(async () => { await service.createParty({ caseId, ...partyForm }); await onRevisionChange(); setPartyForm(null); }); }}>Add party</button></footer>
    </section></div> : null}
  </section>;
}
