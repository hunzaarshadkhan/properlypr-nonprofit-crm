import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { approvedEmails, accessPolicy, readSession, makeSession } from "../server/auth.mjs";
import { createCRMServer } from "../server/server.mjs";
import { openDatabase } from "../dev/database.mjs";
import { googleFixture } from "./google-fixture.mjs";

const folder=mkdtempSync(join(tmpdir(),"crm-google-test-")),filename=join(folder,"test.sqlite");
const probe=createServer();probe.listen(0,"127.0.0.1");await once(probe,"listening");const port=probe.address().port;await new Promise(r=>probe.close(r));
const origin=`http://127.0.0.1:${port}`, fixture=await googleFixture(),google=fixture.provider(origin+"/auth/google/callback");
let allowedEmails=["rep@gmail.com"], db=openDatabase(filename), server=createCRMServer({db,origin,allowedEmails,google});
const start=async()=>{server.listen(port,"127.0.0.1");await once(server,"listening");};
const stop=async()=>{await new Promise(r=>server.close(r));db.close();};
await start();
async function request(path,{data,cookie,headers={},method=data?"POST":"GET"}={}) {
  return fetch(origin+path,{method,redirect:"manual",headers:{Connection:"close",...(data?{"Content-Type":"application/json",Origin:origin}:{}),...(cookie?{Cookie:cookie}:{}),...headers},body:data?JSON.stringify(data):undefined});
}
async function flow() {
  const response=await request("/auth/google");assert.equal(response.status,303);
  const url=new URL(response.headers.get("location"));
  assert.equal(url.origin,"https://accounts.google.com");
  assert.equal(url.searchParams.get("scope"),"openid email profile");
  assert.equal(url.searchParams.get("code_challenge_method"),"S256");
  assert.equal(url.searchParams.get("redirect_uri"),origin+"/auth/google/callback");
  assert.ok(!url.searchParams.has("client_secret"));
  const cookie=response.headers.get("set-cookie").split(";")[0];
  return {url,cookie};
}
async function finish(f,claims={},badSignature=false) {
  const code=fixture.code(f.url,claims,badSignature);
  return request("/auth/google/callback?"+new URLSearchParams({code,state:f.url.searchParams.get("state")}),{cookie:f.cookie});
}
try {
  assert.equal((await request("/healthz")).status,200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM organizations").first().n,0);
  const login=await request("/login"),html=await login.text();assert.ok(html.includes("Continue with Google"));assert.ok(!html.includes('type="password"'));
  assert.equal((await request("/login",{data:{username:"admin",password:"old"}})).status,405);
  assert.equal((await request("/api/directory",{headers:{"oai-authenticated-user-id":"spoofed","X-CRM-Import":"fake"}})).status,401);
  assert.equal((await request("/api/directory",{cookie:"crm_session=legacy.signed.password.token"})).status,401);
  const first=await flow();
  assert.equal((await request("/auth/google/callback?state="+first.url.searchParams.get("state")+"&code=bad")).status,400);
  assert.equal((await request("/auth/google/callback?state=wrong&code=bad",{cookie:first.cookie})).status,400);
  const good=await finish(first);assert.equal(good.status,303);
  const raw=good.headers.getSetCookie().find(v=>v.startsWith("crm_session="));assert.ok(raw.includes("HttpOnly"));assert.ok(raw.includes("SameSite=Lax"));
  const cookie=raw.split(";")[0];
  assert.equal((await finish(first)).status,400,"callbacks must be single use");
  assert.equal((await request("/api/directory",{cookie})).status,200);
  const token=cookie.split("=")[1];assert.ok(await readSession(db,token,accessPolicy({allowedEmails})));
  assert.ok(db.prepare("SELECT token_hash FROM auth_sessions").first().token_hash!==token,"database stores hashes rather than session secrets");
  const wrongCookie=cookie.slice(0,-1)+(cookie.endsWith("a")?"b":"a");assert.equal((await request("/api/directory",{cookie:wrongCookie})).status,401);
  assert.equal((await request("/api/org",{cookie,data:{},headers:{Origin:"https://evil.example"}})).status,403);
  const org={id:"444444444",name:"Google test nonprofit",requestId:crypto.randomUUID(),contact:"Primary contact",contactRole:"Director",email:"contact@example.org",phone:"5555550100",website:"https://example.org",owner:"Team rep",initialNote:"Initial team context"};
  assert.equal((await request("/api/org",{cookie,data:org,headers:{"oai-authenticated-user-id":"spoofed","oai-authenticated-user-email":"spoof@gmail.com"}})).status,200);
  const saved=await(await request("/api/org/444444444",{cookie})).json();assert.equal(saved.history[0].by,"rep@gmail.com");
  assert.equal(saved.email,org.email);assert.equal(saved.savedNotes[0].author,"rep@gmail.com");
  assert.equal((await request("/api/org/444444444/note",{cookie,data:{body:"Persistent Google-authenticated note",requestId:crypto.randomUUID()}})).status,200);
  const page=await request("/",{cookie});assert.ok(page.headers.get("content-security-policy").includes("script-src 'nonce-"));assert.ok((await page.text()).includes('<script nonce="'));
  for(const claims of [{email:"outsider@gmail.com"},{email_verified:false},{nonce:"wrong"},{email:"rep@example.org"}]) assert.equal((await finish(await flow(),claims)).status,403);
  for(const claims of [{aud:"another-client.apps.googleusercontent.com"},{iss:"https://evil.example"},{exp:Math.floor(Date.now()/1000)-1000}]) assert.equal((await finish(await flow(),claims)).status,502,"library must reject invalid signed claims");
  assert.equal((await finish(await flow(),{},true)).status,502,"library must reject invalid signature");
  assert.equal(await makeSession(db,{googleSub:"different-google-sub",email:"rep@gmail.com",name:"Reassigned"}),null,"email cannot silently transfer to another Google identity");
  const expired=await flow();db.prepare("UPDATE auth_flows SET expires=0").run();assert.equal((await finish(expired)).status,400);
  const cancelled=await flow();assert.equal((await request("/auth/google/callback?"+new URLSearchParams({state:cancelled.url.searchParams.get("state"),error:"access_denied"}),{cookie:cancelled.cookie})).status,401);
  const importData={text:"Organization,EIN\nCSV fixture,666666666",mapping:{name:"0",id:"1"},destination:"Available",filename:"qa.csv",requestId:crypto.randomUUID()};
  assert.equal((await request("/api/csv/import",{cookie,data:importData})).status,200);
  const pending=await flow();
  await stop();db=openDatabase(filename);server=createCRMServer({db,origin,allowedEmails,google});await start();
  assert.equal((await finish(pending)).status,303,"pending sign-in survives a process restart");
  assert.equal((await request("/api/directory",{cookie})).status,200,"Google sessions survive restart");
  assert.equal((await(await request("/api/org/444444444",{cookie})).json()).savedNotes[0].body,"Persistent Google-authenticated note");
  const persisted=await(await request("/api/org/444444444",{cookie})).json();
  for(const key of ["contact","contactRole","email","phone","website","owner"]) assert.equal(persisted[key],org[key]);
  assert.ok(persisted.savedNotes.some(n=>n.body==="Initial team context"),"initial note survives restart with profile data");
  const logout=await request("/logout",{cookie,method:"POST",headers:{Origin:origin}});assert.equal(logout.status,303);
  assert.equal((await request("/api/directory",{cookie})).status,401,"logout revokes the server session");
  const again=await finish(await flow());const current=again.headers.getSetCookie().find(v=>v.startsWith("crm_session=")).split(";")[0];
  await stop();db=openDatabase(filename);allowedEmails=["someone-else@gmail.com","rep@example.org"];server=createCRMServer({db,origin,allowedEmails,google});await start();
  assert.equal((await request("/api/directory",{cookie:current})).status,401,"removed users lose existing access");
  const workspace=await flow();
  assert.equal((await finish(workspace,{sub:"workspace-user",email:"rep@example.org",hd:"example.org"})).status,303);
  db.prepare("UPDATE auth_sessions SET expires=0").run();
  assert.equal(await readSession(db,current.split("=")[1],accessPolicy({allowedEmails:["rep@gmail.com"]})),null,"expired sessions are rejected");
  for(let i=0;i<21;i++) await request("/auth/google");assert.equal((await request("/auth/google")).status,429);
  assert.throws(()=>approvedEmails(""),/CRM_ALLOWED_EMAILS/);
  assert.throws(()=>accessPolicy({allowedDomain:"*.properlypr.com"}),/exact/);
  assert.throws(()=>accessPolicy({allowedDomain:"properlypr.com",allowedEmails:["rep@gmail.com"]}),/not both/);
  await stop();db=openDatabase(filename);server=createCRMServer({db,origin,allowedDomain:"properlypr.com",google});await start();
  assert.equal((await request("/api/directory",{cookie:current})).status,401,"an old personal-account session cannot bypass domain policy");
  const domainFlow=await flow();assert.equal(domainFlow.url.searchParams.get("hd"),"properlypr.com");
  const domainLogin=await finish(domainFlow,{sub:"properlypr-first",email:"first@properlypr.com",hd:"properlypr.com"});
  assert.equal(domainLogin.status,303,"any verified member of the exact Workspace can sign in");
  const domainCookie=domainLogin.headers.getSetCookie().find(v=>v.startsWith("crm_session=")).split(";")[0];
  assert.equal((await request("/api/directory",{cookie:domainCookie})).status,200);
  assert.equal((await finish(await flow(),{sub:"properlypr-second",email:"second@properlypr.com",hd:"properlypr.com"})).status,303);
  for(const claims of [
    {email:"outsider@gmail.com",hd:"properlypr.com"},
    {email:"rep@properlypr.com.evil.example",hd:"properlypr.com"},
    {email:"rep@sub.properlypr.com",hd:"properlypr.com"},
    {email:"rep@notproperlypr.com",hd:"properlypr.com"},
    {email:"rep@properlypr.com",hd:undefined},
    {email:"rep@properlypr.com",hd:"other.example"},
    {email:"rep@properlypr.com",hd:"properlypr.com",email_verified:false},
  ]) assert.equal((await finish(await flow(),claims)).status,403,"both verified email domain and signed Workspace domain must match exactly");
  db.prepare("UPDATE crm_users SET hosted_domain='other.example' WHERE google_sub='properlypr-first'").run();
  assert.equal((await request("/api/directory",{cookie:domainCookie})).status,401,"sessions recheck the verified Workspace domain");
  console.log("Passed Google authorization code/PKCE flow with real signed fixture tokens, signature/audience/issuer/expiry verification, nonce/state/replay checks, allowlisting, identity binding, legacy-login removal, CSRF, persisted sessions/data, logout revocation and throttling.");
  console.log("Passed exact properlypr.com Workspace access, multiple team members, Google domain hint, spoofed/similar/subdomain rejection, verified-domain enforcement and session policy checks.");
} finally {await stop();await fixture.close();rmSync(folder,{recursive:true,force:true});}
