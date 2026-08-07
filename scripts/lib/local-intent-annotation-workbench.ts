import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  LocalIntentAnnotationStore,
  type LocalIntentAnnotationStoreOptions,
} from "./local-intent-annotation-store.js";
import type { LocalIntentAnnotationSubmission } from "./local-intent-annotation-schema.js";

export interface StartLocalIntentAnnotationWorkbenchOptions
  extends LocalIntentAnnotationStoreOptions {
  port?: number;
  host?: "127.0.0.1";
  token?: string;
}

export async function startLocalIntentAnnotationWorkbench(
  options: StartLocalIntentAnnotationWorkbenchOptions
) {
  const host = options.host ?? "127.0.0.1";
  const token = options.token ?? randomBytes(24).toString("base64url");
  const store = await LocalIntentAnnotationStore.open(options);
  const server = createServer(async (request, response) => {
    try {
      await routeLocalIntentAnnotationRequest({ request, response, token, store });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    store,
    token,
    url: `http://${host}:${address.port}/?token=${encodeURIComponent(token)}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  };
}

export async function routeLocalIntentAnnotationRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  token: string;
  store: LocalIntentAnnotationStore;
}) {
  const host = input.request.headers.host ?? "127.0.0.1";
  const url = new URL(input.request.url ?? "/", `http://${host}`);
  setSecurityHeaders(input.response);
  if (url.pathname === "/" && input.request.method === "GET") {
    if (url.searchParams.get("token") !== input.token) {
      return sendText(input.response, 403, "Forbidden");
    }
    return sendHtml(input.response, annotationWorkbenchHtml());
  }
  if (input.request.headers["x-jarvis-annotation-token"] !== input.token) {
    return sendJson(input.response, 403, { error: "Forbidden" });
  }
  if (url.pathname === "/api/state" && input.request.method === "GET") {
    return sendJson(input.response, 200, {
      manifest: input.store.manifest,
      cards: input.store.cards,
      latestInitialAnnotations: input.store.latestRecords("initial"),
      progress: input.store.progress(),
    });
  }
  if (url.pathname === "/api/annotations" && input.request.method === "POST") {
    const submission = (await readJsonBody(input.request)) as LocalIntentAnnotationSubmission;
    const record = await input.store.submit(submission);
    return sendJson(input.response, 200, {
      record,
      progress: input.store.progress(),
    });
  }
  return sendJson(input.response, 404, { error: "Not found" });
}

async function readJsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 64 * 1024) throw new Error("Annotation request is too large.");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) throw new Error("Annotation request is empty.");
  return JSON.parse(text) as unknown;
}

function setSecurityHeaders(response: ServerResponse) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
  );
}

function sendHtml(response: ServerResponse, body: string) {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(body);
}

function sendText(response: ServerResponse, status: number, body: string) {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  if (response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function annotationWorkbenchHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Task 155 Annotation Pilot</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; letter-spacing: 0; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #172027; background: #f4f6f7; }
    button { font: inherit; letter-spacing: 0; }
    .topbar { position: sticky; top: 0; z-index: 3; background: #ffffff; border-bottom: 1px solid #d8dee2; }
    .topbar-inner { max-width: 1040px; margin: 0 auto; min-height: 58px; padding: 10px 22px; display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: center; gap: 16px; }
    h1 { margin: 0; font-size: 17px; font-weight: 700; }
    .status { margin-top: 3px; color: #5d6870; font-size: 12px; }
    .progress { min-width: 190px; text-align: right; font-size: 13px; font-variant-numeric: tabular-nums; }
    .track { height: 5px; margin-top: 7px; background: #e0e5e8; overflow: hidden; }
    .fill { height: 100%; width: 0; background: #087f72; transition: width 160ms ease; }
    main { max-width: 1040px; margin: 0 auto; padding: 22px; }
    .source-band { background: #ffffff; border: 1px solid #d6dde1; border-radius: 6px; padding: 18px 20px; }
    .eyebrow { color: #66737b; font-size: 11px; font-weight: 700; text-transform: uppercase; }
    .source-text { margin: 10px 0 0; white-space: pre-wrap; font-size: 18px; line-height: 1.55; }
    .meta { display: flex; flex-wrap: wrap; gap: 7px 14px; margin-top: 14px; color: #66737b; font-size: 12px; }
    .context { margin-top: 14px; border-left: 3px solid #3c7b94; padding: 4px 0 4px 15px; }
    .context-row { margin: 8px 0; white-space: pre-wrap; font-size: 13px; line-height: 1.45; }
    .context-label { color: #66737b; font-weight: 700; margin-right: 7px; }
    form { margin-top: 20px; background: #ffffff; border: 1px solid #d6dde1; border-radius: 6px; padding: 4px 20px 18px; }
    fieldset { min-width: 0; margin: 0; padding: 18px 0; border: 0; border-bottom: 1px solid #e1e6e9; }
    fieldset:last-of-type { border-bottom: 0; }
    legend { padding: 0; font-size: 14px; font-weight: 750; }
    .subhead { margin: 13px 0 7px; color: #59656d; font-size: 12px; font-weight: 700; }
    .segments { display: grid; grid-template-columns: repeat(auto-fit,minmax(150px,1fr)); gap: 7px; }
    .segment { min-height: 38px; border: 1px solid #bcc7cc; border-radius: 5px; background: #fff; color: #263238; padding: 7px 10px; cursor: pointer; font-size: 13px; overflow-wrap: anywhere; }
    .segment:hover { border-color: #4a7685; background: #f3f8f9; }
    .segment.selected { border-color: #087f72; background: #e5f4f0; color: #075c54; box-shadow: inset 0 0 0 1px #087f72; }
    .segment.secondary-selected { border-color: #3c6b93; background: #eaf1f7; color: #244f72; }
    .segment.danger-selected { border-color: #a34b3e; background: #faece8; color: #7f3329; }
    .actions { position: sticky; bottom: 0; display: grid; grid-template-columns: auto auto minmax(0,1fr) auto auto; gap: 8px; align-items: center; margin-top: 18px; padding: 12px; background: rgba(244,246,247,.96); border-top: 1px solid #d6dde1; }
    .action { min-height: 40px; border: 1px solid #aeb9bf; border-radius: 5px; background: #fff; padding: 8px 14px; cursor: pointer; }
    .action.primary { border-color: #087f72; background: #087f72; color: white; font-weight: 700; }
    .action:disabled { opacity: .45; cursor: default; }
    .message { min-width: 0; color: #a33b2b; font-size: 13px; text-align: center; overflow-wrap: anywhere; }
    @media (max-width: 680px) {
      .topbar-inner { grid-template-columns: 1fr; }
      .progress { text-align: left; }
      main { padding: 12px; }
      .segments { grid-template-columns: repeat(2,minmax(0,1fr)); }
      .actions { grid-template-columns: auto auto 1fr; }
      .actions .message { grid-column: 1 / -1; grid-row: 1; }
    }
  </style>
</head>
<body>
  <header class="topbar"><div class="topbar-inner">
    <div><h1>Task 155 · Blinded Pilot</h1><div class="status" id="status">Loading private corpus…</div></div>
    <div class="progress"><span id="progressText">0 / 0</span><div class="track"><div class="fill" id="progressFill"></div></div></div>
  </div></header>
  <main>
    <section class="source-band">
      <div class="eyebrow" id="cardLabel">Source-owned unit</div>
      <div class="source-text" id="sourceText"></div>
      <div class="meta" id="sourceMeta"></div>
      <div class="context" id="context"></div>
    </section>
    <form id="annotationForm">
      <fieldset>
        <legend>Speech Act</legend>
        <div class="subhead">Primary</div><div class="segments" id="speechPrimary"></div>
        <div class="subhead">Secondary (optional)</div><div class="segments" id="speechSecondary"></div>
      </fieldset>
      <fieldset>
        <legend>Question Type</legend><div class="segments" id="questionType"></div>
      </fieldset>
      <fieldset>
        <legend>Phase Control</legend>
        <div class="subhead">Transition intent</div><div class="segments" id="phaseTransition"></div>
        <div class="subhead">Assumption authorized</div><div class="segments" id="assumptionAuthorized"></div>
        <div class="subhead">Requirements complete</div><div class="segments" id="requirementsComplete"></div>
      </fieldset>
      <fieldset>
        <legend>Should Advise · Evaluation Only</legend><div class="segments" id="shouldAdvise"></div>
      </fieldset>
    </form>
    <div class="actions">
      <button class="action" id="previous" title="Previous card" aria-label="Previous card">←</button>
      <button class="action" id="next" title="Next card" aria-label="Next card">→</button>
      <div class="message" id="message"></div>
      <button class="action" id="skip">Skip</button>
      <button class="action primary" id="save">Save &amp; Next</button>
    </div>
  </main>
  <script>
    const token = new URLSearchParams(location.search).get('token');
    const headers = {'X-Jarvis-Annotation-Token': token, 'Content-Type': 'application/json'};
    const labels = {
      speech: ['acknowledgement','question','directive','constraint','correction','phase-control','logistics','informational','unresolved'],
      question: ['behavioral','coding','general-system-design','ai-ml-system-design','project-deep-dive','field-knowledge','unknown','not-applicable','unresolved'],
      transition: ['none','hold','advance','revisit','unresolved'],
      evidence: ['yes','no','unresolved'],
      advise: ['advise','do-not-advise','unresolved']
    };
    const displayNames = {'ai-ml-system-design':'AI/ML System Design','not-applicable':'Not Applicable','do-not-advise':'Do Not Advise'};
    const pretty = value => displayNames[value] || value.split('-').map(word => word.charAt(0).toUpperCase()+word.slice(1)).join(' ');
    let state, index = 0, startedAt = Date.now();
    const selected = new Map();
    const latestByCard = new Map();
    function buildGroup(id, values, multi=false) {
      const root = document.getElementById(id); root.textContent = '';
      values.forEach(value => { const button=document.createElement('button'); button.type='button'; button.className='segment'; button.textContent=pretty(value); button.dataset.value=value; button.onclick=()=>choose(id,value,multi); root.appendChild(button); });
    }
    function choose(id,value,multi) {
      if (multi) { const values=new Set(selected.get(id)||[]); values.has(value)?values.delete(value):values.add(value); selected.set(id,[...values]); }
      else selected.set(id,value);
      paintGroup(id,multi);
    }
    function paintGroup(id,multi) {
      const current=selected.get(id); document.querySelectorAll('#'+id+' .segment').forEach(button=>{ const hit=multi?(current||[]).includes(button.dataset.value):current===button.dataset.value; button.classList.toggle(multi?'secondary-selected':'selected',hit); });
    }
    function textRow(label,value) { if(!value) return null; const row=document.createElement('div'); row.className='context-row'; const lead=document.createElement('span'); lead.className='context-label'; lead.textContent=label; row.append(lead,document.createTextNode(value)); return row; }
    function render() {
      const card=state.cards[index], prior=latestByCard.get(card.cardId); startedAt=Date.now(); selected.clear();
      if(prior?.status==='confirmed') { selected.set('speechPrimary',prior.labels.speechAct.primary); selected.set('speechSecondary',prior.labels.speechAct.secondary); selected.set('questionType',prior.labels.questionType); selected.set('phaseTransition',prior.labels.phaseControl.transitionIntent); selected.set('assumptionAuthorized',prior.labels.phaseControl.assumptionAuthorized); selected.set('requirementsComplete',prior.labels.phaseControl.requirementsComplete); selected.set('shouldAdvise',prior.evaluationFacts.shouldAdvise); }
      ['speechPrimary','speechSecondary','questionType','phaseTransition','assumptionAuthorized','requirementsComplete','shouldAdvise'].forEach(id=>paintGroup(id,id==='speechSecondary'));
      document.getElementById('cardLabel').textContent='Card '+(index+1)+' of '+state.cards.length;
      document.getElementById('sourceText').textContent=card.sourceText;
      document.getElementById('sourceMeta').textContent='';
      [card.source.language,card.source.modality,card.source.unitKind,card.source.integrity,card.source.exactSource?'exact source':'review source'].forEach(value=>{const span=document.createElement('span');span.textContent=value;document.getElementById('sourceMeta').appendChild(span);});
      const context=document.getElementById('context'); context.textContent='';
      const rows=[textRow('Previous them',card.context.previousInterviewerText),...(card.context.interveningMeText||[]).map(value=>textRow('Me',value)),textRow('Parent · context only',card.context.activeParentType),textRow('Phase · context only',card.context.activePhase)].filter(Boolean);
      if(rows.length) rows.forEach(row=>context.appendChild(row)); else context.textContent='No bounded prior context.';
      document.getElementById('previous').disabled=index===0; document.getElementById('next').disabled=index===state.cards.length-1;
      document.getElementById('message').textContent=prior?.status==='skipped'?'Previously skipped':prior?'Saved revision '+prior.revision:'';
      updateProgress();
    }
    function updateProgress(progress=state.progress) { document.getElementById('progressText').textContent=progress.completedCards+' confirmed · '+progress.skippedCards+' skipped · '+progress.remainingCards+' remaining'; document.getElementById('progressFill').style.width=((progress.completedCards+progress.skippedCards)/progress.totalCards*100)+'%'; }
    function submission(status) { const card=state.cards[index]; const base={pilotId:card.pilotId,cardId:card.cardId,exampleId:card.exampleId,sourceHash:card.sourceHash,contextHash:card.contextHash,pass:'initial',status,interaction:{startedAt,submittedAt:Date.now()}}; if(status==='skipped') return base; const required=['speechPrimary','questionType','phaseTransition','assumptionAuthorized','requirementsComplete','shouldAdvise']; const missing=required.filter(id=>!selected.get(id)); if(missing.length) throw new Error('Complete every required field or choose Skip.'); return {...base,labels:{speechAct:{primary:selected.get('speechPrimary'),secondary:selected.get('speechSecondary')||[]},questionType:selected.get('questionType'),phaseControl:{transitionIntent:selected.get('phaseTransition'),assumptionAuthorized:selected.get('assumptionAuthorized'),requirementsComplete:selected.get('requirementsComplete')}},evaluationFacts:{shouldAdvise:selected.get('shouldAdvise')}}; }
    async function submit(status) { try { document.getElementById('message').textContent='Saving…'; const response=await fetch('/api/annotations',{method:'POST',headers,body:JSON.stringify(submission(status))}); const body=await response.json(); if(!response.ok) throw new Error(body.error||'Save failed'); latestByCard.set(body.record.cardId,body.record); state.progress=body.progress; updateProgress(); const next=state.cards.findIndex((card,position)=>position>index&&!latestByCard.has(card.cardId)); index=next>=0?next:Math.min(index+1,state.cards.length-1); render(); } catch(error) { document.getElementById('message').textContent=error.message||String(error); } }
    document.getElementById('previous').onclick=()=>{index=Math.max(0,index-1);render();}; document.getElementById('next').onclick=()=>{index=Math.min(state.cards.length-1,index+1);render();}; document.getElementById('save').onclick=()=>submit('confirmed'); document.getElementById('skip').onclick=()=>submit('skipped');
    window.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key==='Enter'){event.preventDefault();submit('confirmed');}if(event.altKey&&event.key==='ArrowLeft'){event.preventDefault();document.getElementById('previous').click();}if(event.altKey&&event.key==='ArrowRight'){event.preventDefault();document.getElementById('next').click();}});
    buildGroup('speechPrimary',labels.speech); buildGroup('speechSecondary',labels.speech.filter(value=>value!=='unresolved'),true); buildGroup('questionType',labels.question); buildGroup('phaseTransition',labels.transition); buildGroup('assumptionAuthorized',labels.evidence); buildGroup('requirementsComplete',labels.evidence); buildGroup('shouldAdvise',labels.advise);
    fetch('/api/state',{headers}).then(async response=>{const body=await response.json();if(!response.ok)throw new Error(body.error);return body;}).then(body=>{state=body;body.latestInitialAnnotations.forEach(record=>latestByCard.set(record.cardId,record));const first=body.cards.findIndex(card=>!latestByCard.has(card.cardId));index=first>=0?first:0;document.getElementById('status').textContent='Blinded · Pass 1 · '+body.manifest.selectedCards+' cards';render();}).catch(error=>{document.getElementById('status').textContent='Error';document.getElementById('message').textContent=error.message||String(error);});
  </script>
</body>
</html>`;
}
