import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Ban,
  ChevronLeft,
  Edit3,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  Send,
  Settings2,
  X,
} from "lucide-react";
import MossSelect from "@/components/ui/MossSelect";
import {
  PreparationConversationService,
  type CallPlan,
  type PreparationConversation,
  type PreparationMessage,
} from "@/lib/preparation";

interface ConversationPanelProps {
  caseId: string;
  plans: CallPlan[];
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

interface ConversationForm {
  title: string;
  callPlanId: string;
}

const scopeLabel = (conversation: PreparationConversation, plans: CallPlan[]) =>
  conversation.callPlanId
    ? plans.find((plan) => plan.id === conversation.callPlanId)?.title ?? "Deleted call plan"
    : "Entire case";

export default function ConversationPanel({
  caseId,
  plans,
  expanded,
  onExpandedChange,
}: ConversationPanelProps) {
  const [service, setService] = useState<PreparationConversationService | null>(null);
  const [conversations, setConversations] = useState<PreparationConversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<PreparationMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streamedText, setStreamedText] = useState("");
  const [form, setForm] = useState<ConversationForm | null>(null);
  const [editingMessage, setEditingMessage] = useState<PreparationMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedId) ?? null,
    [conversations, selectedId]
  );

  const refreshConversations = useCallback(async (
    owner: PreparationConversationService,
    preferredId?: string
  ) => {
    const next = await owner.list(caseId);
    setConversations(next);
    setSelectedId((current) => {
      const candidate = preferredId ?? current;
      return candidate && next.some((item) => item.id === candidate)
        ? candidate
        : next[0]?.id ?? null;
    });
  }, [caseId]);

  useEffect(() => {
    let active = true;
    void PreparationConversationService.open()
      .then(async (owner) => {
        if (!active) return;
        setService(owner);
        await refreshConversations(owner);
      })
      .catch((reason) => active && setError(String(reason)));
    return () => { active = false; };
  }, [refreshConversations]);

  useEffect(() => {
    if (!service || !selectedId) {
      setMessages([]);
      return;
    }
    let active = true;
    void service.messages(selectedId)
      .then((next) => active && setMessages(next))
      .catch((reason) => active && setError(String(reason)));
    return () => { active = false; };
  }, [selectedId, service]);

  useEffect(() => {
    if (!expanded) return;
    const restoreWorkspace = (event: KeyboardEvent) => {
      if (event.key === "Escape") onExpandedChange(false);
    };
    window.addEventListener("keydown", restoreWorkspace);
    return () => window.removeEventListener("keydown", restoreWorkspace);
  }, [expanded, onExpandedChange]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === "AbortError")) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
      setStreamedText("");
    }
  };

  const saveConversation = () => {
    if (!service || !form) return;
    void run(async () => {
      if (selected) {
        await service.updateMetadata({
          conversation: selected,
          title: form.title,
          callPlanId: form.callPlanId || undefined,
        });
        await refreshConversations(service, selected.id);
      } else {
        const created = await service.create({
          caseId,
          title: form.title,
          callPlanId: form.callPlanId || undefined,
        });
        await refreshConversations(service, created.id);
      }
      setForm(null);
    });
  };

  const submit = () => {
    if (!service || !selected || !draft.trim()) return;
    const content = draft;
    setDraft("");
    void run(async () => {
      await service.send({
        conversation: selected,
        content,
        onText: setStreamedText,
      });
      await refreshConversations(service, selected.id);
      setMessages(await service.messages(selected.id));
    });
  };

  const regenerate = () => {
    if (!service || !selected || !editingMessage || !draft.trim()) return;
    const content = draft;
    const target = editingMessage;
    setEditingMessage(null);
    setDraft("");
    void run(async () => {
      await service.editAndRegenerate({
        conversation: selected,
        messageId: target.id,
        content,
        onText: setStreamedText,
      });
      await refreshConversations(service, selected.id);
      setMessages(await service.messages(selected.id));
    });
  };

  return (
    <section className={`preparation-conversations${expanded ? " expanded" : ""}`}>
      <aside className={selected ? "conversation-index compact" : "conversation-index"}>
        <header className="case-section-toolbar">
          <div><h3>Preparation conversations</h3><p>Each session has an explicit evidence scope.</p></div>
          <button type="button" title="New conversation" aria-label="New conversation" onClick={() => {
            setSelectedId(null);
            setForm({ title: "", callPlanId: "" });
          }}><MessageSquarePlus size={15} /></button>
        </header>
        <div className="conversation-list">
          {conversations.map((conversation) => (
            <button
              type="button"
              key={conversation.id}
              className={conversation.id === selectedId ? "active" : ""}
              onClick={() => setSelectedId(conversation.id)}
            >
              <span><strong>{conversation.title}</strong><small>{scopeLabel(conversation, plans)}</small></span>
              <time>{new Date(conversation.updatedAt).toLocaleDateString()}</time>
            </button>
          ))}
          {conversations.length === 0 ? <div className="material-empty"><MessageSquarePlus size={20} /><p>Create a scoped preparation session.</p></div> : null}
        </div>
      </aside>

      {selected ? <div className="conversation-thread">
        <header>
          <button type="button" className="conversation-back" title="Conversation history" onClick={() => { onExpandedChange(false); setSelectedId(null); }}><ChevronLeft size={16} /></button>
          <div><h3>{selected.title}</h3><p>{scopeLabel(selected, plans)} · revision {selected.headRevision}</p></div>
          <div className="conversation-thread-actions">
            <button type="button" title="Edit conversation" onClick={() => setForm({ title: selected.title, callPlanId: selected.callPlanId ?? "" })}><Settings2 size={15} /></button>
            <button
              type="button"
              title={expanded ? "Restore Case workspace" : "Expand conversation"}
              aria-label={expanded ? "Restore Case workspace" : "Expand conversation"}
              aria-pressed={expanded}
              onClick={() => onExpandedChange(!expanded)}
            >
              {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
          </div>
        </header>
        <div className="conversation-messages">
          {messages.map((message) => <article key={message.id} className={message.role}>
            <div><span>{message.role === "user" ? "You" : "MOSS"}</span>{message.role === "user" ? <button type="button" title="Edit from this message" disabled={busy} onClick={() => { setEditingMessage(message); setDraft(message.content); }}><Edit3 size={12} /></button> : null}</div>
            <p>{message.content}</p>
            {message.contextManifest ? <small>{message.contextManifest.extractionChunkIds.length} source chunks · {message.contextManifest.statementIds.length} confirmed statements</small> : null}
          </article>)}
          {streamedText ? <article className="assistant streaming"><div><span>MOSS</span><em>Generating</em></div><p>{streamedText}</p></article> : null}
        </div>
        {error ? <div className="case-inline-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}><X size={13} /></button></div> : null}
        <footer className="conversation-composer">
          {editingMessage ? <div className="conversation-edit-notice"><span>Editing message {editingMessage.revision}. Later messages will be superseded.</span><button type="button" onClick={() => { setEditingMessage(null); setDraft(""); }}><X size={13} /></button></div> : null}
          <textarea
            value={draft}
            placeholder="Ask about this case, prepare a call, or inspect an evidence gap..."
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                editingMessage ? regenerate() : submit();
              }
            }}
          />
          {busy ? <button type="button" className="cancel" title="Cancel generation" onClick={() => service?.cancel(selected.id)}><Ban size={16} /></button> : <button type="button" title={editingMessage ? "Regenerate from edit" : "Send"} disabled={!draft.trim()} onClick={editingMessage ? regenerate : submit}><Send size={16} /></button>}
        </footer>
      </div> : null}

      {form ? <div className="case-modal-layer"><section className="case-modal" role="dialog" aria-modal="true">
        <header><div><span>Conversation session</span><h2>{selected ? "Edit session" : "New preparation session"}</h2></div><button type="button" onClick={() => setForm(null)}><X size={17} /></button></header>
        <label>Title <small>Defaults to the first message</small><input autoFocus value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
        <label>Scope<MossSelect ariaLabel="Conversation scope" value={form.callPlanId} onValueChange={(callPlanId) => setForm({ ...form, callPlanId })} options={[{ value: "", label: "Entire case" }, ...plans.map((plan) => ({ value: plan.id, label: plan.title }))]} /></label>
        <footer><button type="button" className="secondary" onClick={() => setForm(null)}>Cancel</button><button type="button" disabled={busy} onClick={saveConversation}>{selected ? "Save" : "Create"}</button></footer>
      </section></div> : null}
    </section>
  );
}
