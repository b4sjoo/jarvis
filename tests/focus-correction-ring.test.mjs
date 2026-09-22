import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { build } from "esbuild";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";

const root = process.cwd();
let playwright;
try { playwright = createRequire(import.meta.url)(process.env.JARVIS_PLAYWRIGHT_MODULE ?? "playwright"); } catch {}

function source(file) {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function declaration(ast, name) {
  const node = ast.statements.find(node =>
    ts.isFunctionDeclaration(node) && node.name?.text === name ||
    ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(ast) === name));
  assert.ok(node, `production declaration ${name}`);
  return node.getText(ast);
}

test("FC-R1/R2 isolated production Focus correction rings, geometry and controls", {
  skip: !playwright && "Set JARVIS_PLAYWRIGHT_MODULE to run the isolated browser proof",
}, async () => {
  const native = source("src/pages/app/components/meeting/focus-window.tsx");
  const embedded = source("src/pages/app/components/meeting/index.tsx");
  const wrappers = [];
  const visit = node => {
    if (ts.isJsxElement(node) && node.openingElement.getText(native).includes('className="mt-auto min-h-[36px] min-w-0 shrink overflow-y-auto"')) {
      wrappers.push(node.getText(native));
    }
    ts.forEachChild(node, visit);
  };
  visit(native);
  assert.equal(wrappers.length, 1, "the production native clipping container");
  const normalInputs = [];
  const visitNormal = node => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(embedded) === "Input" &&
      node.getText(embedded).includes("value={speechCorrectionInput}")) normalInputs.push(node.parent.getText(embedded));
    ts.forEachChild(node, visitNormal);
  };
  visitNormal(embedded);
  assert.equal(normalInputs.length, 1, "the unchanged production Normal correction input and Apply button");
  const fixture = `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {Input} from './src/components/ui/input';
    import {Button} from './src/components/ui/button';
    import {Badge} from './src/components/ui/badge';
    import {SendIcon,Loader2Icon,XIcon} from 'lucide-react';
    import {cn} from './src/lib/utils';
    ${declaration(native, "formatFocusTermCorrectionStatus")}
    ${declaration(embedded, "formatTermCorrectionStatus")}
    ${declaration(embedded, "SpeechCorrectionControl")}
    const terms = long => [
      {id:'active',input:'RAG not rec',from:'rec',to:long?'RAG_'+'long_term_'.repeat(25):'RAG',appliedCount:3,activeQuestion:{disposition:'current-question-overlay',regenerationStatus:'running'}},
      {id:'stopped',input:'Old correction',from:'old',to:long?'replacement_'+'long_term_'.repeat(25):'new',deactivatedAt:1,appliedCount:1},
    ];
    window.__ringActions=[];
    window.__longTerms={};
    const record=(surface,action)=>window.__ringActions.push({surface,...action});
    function Native(){
      const [correction,setCorrection]=useState('RAG not rec');
      const [long,setLong]=useState(false); window.__longTerms.native=setLong;
      const snapshot={active:true,speechCorrections:terms(long)};
      const submitCorrection=()=>record('native',{type:'submit-correction',correction});
      const sendFocusAction=action=>record('native',action);
      return ${wrappers[0]};
    }
    function Embedded({compact}){
      const [value,onChange]=useState('RAG not rec');
      const [long,setLong]=useState(false); window.__longTerms[compact?'embedded':'normal']=setLong;
      return <SpeechCorrectionControl compact={compact} value={value} onChange={onChange}
        onSubmit={()=>record(compact?'embedded':'normal',{type:'submit-correction',correction:value})}
        onDeactivate={correctionId=>record(compact?'embedded':'normal',{type:'deactivate-correction',correctionId})}
        disabled={false} corrections={terms(long)}/>;
    }
    function Normal(){
      const [speechCorrectionInput,setSpeechCorrectionInput]=useState('RAG not rec');
      const meeting={status:'listening'};
      const handleSpeechCorrectionSubmit=()=>record('normal',{type:'submit-correction',correction:speechCorrectionInput});
      return ${normalInputs[0]};
    }
    createRoot(document.getElementById('native')).render(<Native/>);
    createRoot(document.getElementById('embedded')).render(<Embedded compact/>);
    createRoot(document.getElementById('normal')).render(<Normal/>);
  `;
  const bundle = await build({ stdin: { contents: fixture, resolveDir: root, loader: "tsx" }, bundle: true,
    format: "iife", platform: "browser", write: false, alias: { "@": path.join(root, "src") }, jsx: "automatic" });
  const css = await compile(readFileSync("src/global.css", "utf8"), { base: path.join(root, "src"), onDependency() {} });
  const scanner = new Scanner({ sources: [
    { base: root, pattern: "src/pages/app/components/meeting/*.tsx", negated: false },
    { base: root, pattern: "src/components/ui/*.tsx", negated: false },
  ] });
  const out = process.env.JARVIS_FOCUS_RING_OUTPUT;
  if (out) mkdirSync(out, { recursive: true });
  const browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.JARVIS_CHROMIUM_EXECUTABLE });
  const rows = [];
  try {
    for (const width of [380, 960]) {
      const page = await browser.newPage({ viewport: { width, height: 340 } });
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/*", route => route.abort());
      await page.setContent('<section><div id="native"></div></section><section><div id="embedded"></div></section><section><div id="normal"></div></section>');
      await page.addStyleTag({ content: css.build(scanner.scan()) + "body{position:static;overflow:auto;height:auto;background:white}section{padding:12px;border:1px solid #aaa}#embedded,#normal{min-width:0}" });
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      for (const surface of ["native", "embedded", "normal"]) {
        const area = page.locator(`#${surface}`);
        const input = area.getByPlaceholder("Correction: RAG not rec / Glean");
        await input.waitFor();
        const read = () => input.evaluate(el => {
          const rect = el.getBoundingClientRect(), cs = getComputedStyle(el);
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            focusVisible: el.matches(":focus-visible"), ringInset: cs.getPropertyValue("--tw-ring-inset").trim(),
            shadow: cs.boxShadow, padding: cs.padding, border: cs.borderWidth };
        });
        const unfocused = await read();
        await input.click();
        await page.waitForFunction(el => el.matches(":focus-visible"), await input.elementHandle());
        // Wait for the shared Input's existing box-shadow transition to settle.
        await page.waitForTimeout(200);
        const mouse = await read();
        await input.press("Tab");
        await page.keyboard.press("Shift+Tab");
        const keyboard = await read();
        assert.equal(keyboard.focusVisible, true);
        for (const state of [mouse, keyboard]) {
          for (const key of ["x", "y", "width", "height", "padding", "border"]) assert.equal(state[key], unfocused[key], `${surface} ${key} remains stable`);
          assert.equal(state.ringInset, surface === "normal" ? "" : "inset");
        }
        if (surface !== "normal") assert.match(mouse.shadow, /inset/);
        else assert.doesNotMatch(mouse.shadow, /inset/);
        assert.equal(await area.evaluate(el => el.scrollWidth <= el.clientWidth), true, `${surface} terms stay contained`);
        assert.equal(await area.getByText(/stopped/).count(), surface === "normal" ? 0 : 1);
        if (out) await area.screenshot({ path: path.join(out, `${surface}-ring-${width}.png`) });
        if (surface !== "normal") {
          // Reproduce the old outward ring without changing production or geometry.
          await input.evaluate(el => el.classList.remove("focus-visible:ring-inset"));
          await page.waitForTimeout(200);
          const prior = await read();
          for (const key of ["x", "y", "width", "height", "padding", "border"]) assert.equal(prior[key], mouse[key]);
          if (out) await area.screenshot({ path: path.join(out, `${surface}-outward-control-${width}.png`) });
          await input.evaluate(el => el.classList.add("focus-visible:ring-inset"));
        }
        await input.fill("Corrected term");
        await area.getByRole("button", { name: "Apply", exact: true }).click();
        assert.deepEqual(await page.evaluate(() => window.__ringActions.at(-1)), { surface, type: "submit-correction", correction: "Corrected term" });
        await input.press("Enter");
        assert.deepEqual(await page.evaluate(() => window.__ringActions.at(-1)), { surface, type: "submit-correction", correction: "Corrected term" });
        if (surface !== "normal") {
          await area.getByRole("button", { name: "Stop correction rec", exact: true }).click();
          assert.deepEqual(await page.evaluate(() => window.__ringActions.at(-1)), { surface, type: "deactivate-correction", correctionId: "active" });
        }
        await input.fill("");
        assert.equal(await area.getByRole("button", { name: "Apply", exact: true }).isDisabled(), true);
        if (surface === "normal") {
          rows.push({ width, surface, unfocused, mouse, keyboard });
          continue;
        }
        await page.evaluate(surface => window.__longTerms[surface](true), surface);
        await area.getByText(/RAG_long_term_/).waitFor();
        await input.focus();
        await page.waitForTimeout(200);
        const measureLongTerms = () => area.evaluate(el => {
          const button = el.querySelector('[aria-label="Stop correction rec"]');
          const rect = button.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return { contained: el.scrollWidth <= el.clientWidth,
            cancelHitTarget: button.contains(hit), cancelX: rect.x, cancelY: rect.y };
        });
        const longTerms = await measureLongTerms();
        assert.equal(longTerms.contained, true, `${surface} long terms do not add horizontal scrolling`);
        if (out) await area.screenshot({ path: path.join(out, `${surface}-long-terms-${width}.png`) });
        await input.evaluate(el => el.classList.remove("focus-visible:ring-inset"));
        const priorLongTerms = await measureLongTerms();
        assert.deepEqual(longTerms, priorLongTerms, "long-term layout and pointer hit target are unchanged by the ring fix");
        rows.push({ width, surface, unfocused, mouse, keyboard, longTerms, priorLongTerms });
      }
      // Exercise the same native clipping container under vertical pressure.
      const clipping = page.locator('#native > div');
      const overflow = await clipping.evaluate(el => {
        el.style.height = "40px";
        el.scrollTop = 20;
        return { x: getComputedStyle(el).overflowX, y: getComputedStyle(el).overflowY,
          scrollTop: el.scrollTop, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
      });
      assert.equal(overflow.x, "auto");
      assert.equal(overflow.y, "auto");
      assert.ok(overflow.scrollTop > 0);
      assert.equal(overflow.scrollWidth, overflow.clientWidth);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
  if (out) writeFileSync(path.join(out, "focus-ring-measurements.json"), JSON.stringify({
    scope: "Isolated production correction JSX/Input/CSS; controlled callbacks. Chromium, not native WebKit or a live Jarvis meeting.", rows,
  }, null, 2) + "\n");
});
