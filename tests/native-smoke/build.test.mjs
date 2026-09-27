import assert from "node:assert/strict";
import test from "node:test";
import {APP_ID,createBuildConfig,assertBuildIdentity} from "./build.mjs";

test("smoke config keeps ordinary window behavior and isolates identity/output",()=>{
  const base={app:{windows:[{label:"main",width:600,height:54,contentProtected:true}]}};
  const before=structuredClone(base);
  const a=createBuildConfig(base,"/tmp/smoke-frontend","build-a");
  const b=createBuildConfig(base,"/tmp/smoke-frontend","build-b");
  assert.deepEqual(base,before);
  assert.equal(a.identifier,APP_ID);
  assert.equal(a.build.frontendDist,"/tmp/smoke-frontend");
  assert.equal(a.build.beforeBuildCommand,"");
  assert.equal(a.app.windows[0].contentProtected,true);
  assert.notEqual(a.app.windows[0].title,b.app.windows[0].title);
});

test("failed, old and foreign builds never become valid smoke candidates",()=>{
  const current={status:"built",executableSha256:"new"};
  assert.doesNotThrow(()=>assertBuildIdentity(current,APP_ID,"new"));
  assert.throws(()=>assertBuildIdentity(current,APP_ID,"old"));
  assert.throws(()=>assertBuildIdentity(current,"dev.seasonsg.jarvis","new"));
  assert.throws(()=>assertBuildIdentity({...current,status:"failed"},APP_ID,"new"));
});
