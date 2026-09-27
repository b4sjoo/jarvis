import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publishedApp, workspace } from "./build.mjs";
import { finishKeyboard, logSince, prepareKeyboard, sendShortcut } from "./keyboard.mjs";

const action = "meeting_focus_mode";
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-keyboard-"));
  t.after(() => fs.rmSync(base, {recursive:true,force:true}));
  const dir = path.join(base,"run"); fs.mkdirSync(dir);
  const write = (file,data) => fs.writeFileSync(file,JSON.stringify(data));
  const manifest = {status:"built",id:"build",appPath:publishedApp,keyboardHelper:path.join(workspace,"keyboard-helper")};
  const lifecycle = {status:"running",buildId:"build",pid:123,appPath:publishedApp,directory:dir};
  const snapshot = {buildId:"build",pid:123,shortcutBindings:{meeting_focus_mode:"cmd+shift+j",toggle_dashboard:"cmd+shift+d"}};
  write(path.join(base,"build.json"),manifest); write(path.join(dir,"lifecycle.json"),lifecycle);
  const log = path.join(dir,"stderr.log");
  fs.writeFileSync(log,`历史日志\nNativeSmokeObservation ${JSON.stringify(snapshot)}\n`);
  return {dir,base,log,manifest,lifecycle,snapshot,write,
    state:()=>JSON.parse(fs.readFileSync(path.join(dir,"keyboard.json"))),
    append:text=>fs.appendFileSync(log,text)};
}
function sender(f, output = `Shortcut triggered: ${action}\n`) {
  let calls = 0;
  return {get calls(){return calls;}, send:async(_helper,args)=>{
    calls++; f.append(output);
    return {status:"posted-not-yet-observed",pid:Number(args[0]),action:args[2],binding:args[3],
      keyDownPosted:true,keyUpPosted:true,modifierFlagsBefore:0,modifierFlagsAfter:0};
  }};
}

test("actual snapshot/run binding is frozen once; native receipt is not a UI pass", async t=>{
  const f=fixture(t); prepareKeyboard(f.dir);
  assert.throws(()=>prepareKeyboard(f.dir),/EEXIST/);
  const s=sender(f); const result=await sendShortcut(f.dir,action,{sender:s.send});
  assert.equal(result.status,"native-received"); assert.equal(s.calls,1);
  assert.equal((await finishKeyboard(f.dir)).finished,true);
  await assert.rejects(sendShortcut(f.dir,action,{sender:s.send}),/stopped/);
  assert.equal(s.calls,1);
});

for(const change of ["wrong-build","wrong-pid","wrong-app","stopped-run","missing-snapshot","missing-binding"]){
  test(`preparation rejects ${change}`,t=>{
    const f=fixture(t);
    if(change==="wrong-build")f.lifecycle.buildId="other";
    if(change==="wrong-pid")f.snapshot.pid=999;
    if(change==="wrong-app")f.manifest.appPath="/Applications/Jarvis.app";
    if(change==="stopped-run")f.lifecycle.status="quit-confirmed";
    if(change==="missing-binding")delete f.snapshot.shortcutBindings;
    f.write(path.join(f.base,"build.json"),f.manifest);f.write(path.join(f.dir,"lifecycle.json"),f.lifecycle);
    fs.writeFileSync(f.log,change==="missing-snapshot"?"":`NativeSmokeObservation ${JSON.stringify(f.snapshot)}\n`);
    assert.throws(()=>prepareKeyboard(f.dir));
    assert.equal(fs.existsSync(path.join(f.dir,"keyboard.json")),false);
  });
}

test("unknown action has no observed binding and never invokes sender",async t=>{
  const f=fixture(t);prepareKeyboard(f.dir);const s=sender(f);
  await assert.rejects(sendShortcut(f.dir,"meeting_screen_context",{sender:s.send}),/no observed/);
  assert.equal(s.calls,0);assert.equal(f.state().failed,true);
});

for(const reason of ["Event-post permission unavailable","Unsupported Focus binding","Concurrent or missing Jarvis instance"]){
  test(`native blocked result stops without retry: ${reason}`,async t=>{
    const f=fixture(t);prepareKeyboard(f.dir);let calls=0;
    const blocked=async()=>{calls++;return {status:"blocked",reason,keysPosted:0};};
    await assert.rejects(sendShortcut(f.dir,action,{sender:blocked}),new RegExp(reason));
    await assert.rejects(sendShortcut(f.dir,action,{sender:blocked}),/stopped/);
    assert.equal(calls,1);assert.equal(f.state().actions[0].status,"failed");
  });
}

test("changed registration rejects before any post",async t=>{
  const f=fixture(t);prepareKeyboard(f.dir);const s=sender(f);
  f.append("Updating shortcuts with 15 bindings\n");
  await assert.rejects(sendShortcut(f.dir,action,{sender:s.send}),/registration changed/);
  assert.equal(s.calls,0);
});

test("PID change after preparation rejects before posting",async t=>{
  const f=fixture(t);prepareKeyboard(f.dir);const s=sender(f);
  f.lifecycle.pid=999;f.write(path.join(f.dir,"lifecycle.json"),f.lifecycle);
  await assert.rejects(sendShortcut(f.dir,action,{sender:s.send}),/another run/);
  assert.equal(s.calls,0);
});

test("missing receipt times out once and poisons the run",async t=>{
  const f=fixture(t);prepareKeyboard(f.dir);const s=sender(f,"");let time=0;
  await assert.rejects(sendShortcut(f.dir,action,{sender:s.send,timeoutMs:50,now:()=>time,wait:async()=>{time+=25;}}),/timed out/);
  assert.equal(s.calls,1);assert.equal(f.state().failed,true);
});

for(const bad of [{keyUpPosted:false},{modifierFlagsAfter:1},{binding:"wrong"},{pid:999}]){
  test(`incomplete native delivery fails without resending ${JSON.stringify(bad)}`,async t=>{
    const f=fixture(t);prepareKeyboard(f.dir);const s=sender(f);
    await assert.rejects(sendShortcut(f.dir,action,{sender:async(...args)=>({...await s.send(...args),...bad})}),/Incomplete/);
    assert.equal(s.calls,1);assert.equal(f.state().failed,true);
  });
}

for(const output of [`Shortcut triggered: ${action}\nShortcut triggered: ${action}\n`,"Shortcut triggered: toggle_dashboard\n"]){
  test("duplicate or mismatched callbacks cannot be accepted",async t=>{
    const f=fixture(t);prepareKeyboard(f.dir);const s=sender(f,output);
    await assert.rejects(sendShortcut(f.dir,action,{sender:s.send}),/duplicate/);
    assert.equal(s.calls,1);assert.equal(f.state().failed,true);
  });
}

test("late duplicate is detected at finish",async t=>{
  const f=fixture(t);prepareKeyboard(f.dir);const s=sender(f);
  await sendShortcut(f.dir,action,{sender:s.send});f.append(`Shortcut triggered: ${action}\n`);
  await assert.rejects(finishKeyboard(f.dir),/duplicate/);
});

test("parallel command is refused while the first owns the run",async t=>{
  const f=fixture(t);prepareKeyboard(f.dir);let release;
  const ready=new Promise(resolve=>{release=resolve;});const s=sender(f);
  const first=sendShortcut(f.dir,action,{sender:async(...args)=>{await ready;return s.send(...args);}});
  await assert.rejects(sendShortcut(f.dir,action,{sender:s.send}),/EEXIST/);
  release();await first;assert.equal(s.calls,1);
});

test("log offsets preserve partial UTF-8 and reject truncation",t=>{
  const f=fixture(t);fs.writeFileSync(f.log,"一行\npartial");
  const first=logSince(f.log,0);assert.equal(first.end,Buffer.byteLength("一行\n"));
  f.append("完成\n");assert.equal(logSince(f.log,first.end).lines[0].line,"partial完成");
  fs.writeFileSync(f.log,"");assert.throws(()=>logSince(f.log,first.end),/truncated/);
});
