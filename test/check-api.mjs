import { openDatabase } from "../dev/database.mjs";

import assert from "node:assert/strict";
import app from "../dist/server/index.js";
const db = openDatabase(":memory:");
const environment = { DB: db, CRM_IMPORT_KEY: "fixture-only" },
  code = () => crypto.randomUUID(),
  url = "https://crm.example";
async function call(path, p, mode = "user") {
  const headers = { "Content-Type": "application/json" };
  if (mode === "user") headers["oai-authenticated-user-id"] = "rep";
  if (mode === "seed") headers["X-CRM-Import"] = "fixture-only";
  const resp = await app.fetch(
    new Request(url + path, {
      method: p ? "POST" : "GET",
      headers,
      body: p ? JSON.stringify(p) : undefined,
    }),
    environment,
  );
  return [resp.status, await resp.json()];
}
const base = {
  id: "111111111",
  name: "Fixture",
  tab: "First call",
  status: "Awaiting first call",
  step: "Make first call",
  due: "2002-11-02",
  people: [],
  notes: [],
  history: [],
};
assert.equal((await call("/api/directory", null, "none"))[0], 401);
assert.equal((await call("/api/import", [base]))[0], 403);
assert.equal((await call("/api/import", [base], "seed"))[0], 200);
const route = "/api/org/" + base.id,
  id = code();
const save = { body: "Test persistence", requestId: id };
assert.equal((await call(route + "/note", save))[0], 200);
assert.equal((await call(route + "/note", save))[1].savedNotes.length, 1);
assert.equal((await call(route))[1].savedNotes[0].body, save.body);
const update = {
  type: "outcome",
  rev: 1,
  action: "No answer",
  asOf: "2002-11-02",
  requestId: code(),
};
let [status, rec] = await call(route + "/update", update);
assert.equal(status, 200);
assert.equal(rec.step, "Cold call 2");
assert.equal((await call(route + "/update", update))[1].history.length, 1);
assert.equal(
  (
    await call(route + "/update", {
      ...update,
      action: "Meeting booked",
      requestId: code(),
    })
  )[0],
  409,
);
[status, rec] = await call(route + "/update", {
  type: "outcome",
  rev: 2,
  action: "Meeting booked",
  agreed: "2002-11-11T14:00",
  asOf: "2002-11-04",
  requestId: code(),
});
assert.equal(status, 200);
assert.equal(rec.tab, "Meetings");
assert.equal((await call("/api/import", [base], "seed"))[0], 200);
assert.equal((await call(route))[1].tab, "Meetings");
[status, rec] = await call(route + "/update", {
  type: "profile",
  rev: 3,
  fields: { owner: "Test rep", email: "test@example.org" },
  requestId: code(),
});
assert.equal(status, 200);
assert.equal(rec.owner, "Test rep");
assert.equal(
  (
    await call(route + "/update", {
      type: "profile",
      rev: 3,
      fields: { owner: "Other rep" },
      requestId: code(),
    })
  )[0],
  409,
);
assert.equal(
  (
    await call(route + "/update", {
      type: "profile",
      rev: 4,
      fields: { owner: "Other rep", email: "invalid" },
      requestId: code(),
    })
  )[0],
  400,
);
assert.equal((await call(route))[1].owner, "Test rep");
console.log(
  "Passed: private access, import restrictions, note persistence and retry, outcome retry, booking transition, stale updates, profile validation and original preservation.",
);
const fresh = { name: "QA nonprofit", id: "22-2222222", requestId: code() };
assert.equal((await call("/api/org", fresh))[1].tab, "Available");
assert.equal((await call("/api/org", { ...fresh, requestId: code() }))[0], 409);
const batch = { ids: ["222222222"], requestId: code() };
assert.equal((await call("/api/batch", batch))[1].added, 1);
assert.equal((await call("/api/batch", batch))[1].added, 1);
const freshRoute = "/api/org/222222222";
assert.equal((await call(freshRoute))[1].tab, "First call");
const person = {
  rev: 2,
  type: "person",
  name: "Sample director",
  role: "Director",
  year: "2025",
  source: "https://example.org",
  requestId: code(),
};
assert.equal((await call(freshRoute + "/update", person))[1].people.length, 1);
assert.equal((await call(freshRoute + "/update", person))[1].people.length, 1);
console.log(
  "Passed: adding an organization, EIN uniqueness, batch retry, and preserving a board entry.",
);
const rich = {
  id:"03-3333333", name:"Rich profile fixture", requestId:code(),
  contact:"Alex Example",contactRole:"Development director",email:"alex@example.org",phone:"+1 (555) 555-0100",
  website:"https://www.example.org/about",address:"10 Example Street, Sample City",focus:"Education",
  owner:"QA rep",allowed:"Yes",permissionEvidence:"Requested information during a call",
  candidate:"candidate@example.org",mission:"Community programs",revenue:"$730,009.00",period:"2025-12",
  research:"Filing research",researchSource:"https://example.org/report",initialNote:"Referred by a partner",startIn:"First call",
};
[status,rec] = await call("/api/org",rich);
assert.equal(status,200);
assert.equal(rec.id,"033333333");
for(const key of ["contact","contactRole","email","phone","address","focus","owner","allowed","permissionEvidence","candidate","mission","period","research","researchSource"]) assert.equal(rec[key],rich[key]);
assert.equal(rec.domain,"example.org");assert.equal(rec.revenue,"730009.00");
assert.equal(rec.tab,"First call");assert.equal(rec.step,"Make first call");assert.equal(rec.history.length,1);
assert.equal(rec.savedNotes.length,1);assert.equal(rec.savedNotes[0].body,rich.initialNote);assert.equal(rec.savedNotes[0].author,"rep");
assert.equal((await call("/api/org",rich))[1].savedNotes.length,1,"retry must not duplicate the initial note");
const directory=(await call("/api/directory"))[1].orgs.find(o=>o.id===rec.id);
assert.equal(directory.email,rich.email);assert.equal(directory.contactRole,rich.contactRole);assert.equal(directory.owner,rich.owner);
assert.equal((await call("/api/org",{...rich,requestId:code(),email:"new@example.org"}))[0],409);
assert.equal((await call("/api/org/033333333"))[1].email,rich.email,"duplicate EIN must not overwrite details");
const countBefore=db.prepare("SELECT COUNT(*) n FROM organizations").first().n;
for(const extras of [{email:"not-email"},{website:"javascript:alert(1)"},{researchSource:"file:///secret"},{revenue:"-12"},{period:"2025-13"},{allowed:"Maybe"},{status:"Won"},{history:[]},{startIn:"Meetings"}]) {
  assert.equal((await call("/api/org",{...rich,id:"444444444",requestId:code(),...extras}))[0],400);
}
assert.equal(db.prepare("SELECT COUNT(*) n FROM organizations").first().n,countBefore,"invalid creation must not leave partial organizations");
const conflictId=code();
await call(route+"/note",{body:"Existing note",requestId:conflictId});
assert.equal((await call("/api/org",{...rich,id:"444444444",requestId:conflictId}))[0],500);
assert.equal(db.prepare("SELECT COUNT(*) n FROM organizations").first().n,countBefore,"a note failure rolls back the organization");
const parallel={...rich,id:"555555555",requestId:code()};
const results=await Promise.all([call("/api/org",parallel),call("/api/org",parallel)]);
assert.ok(results.every(r=>r[0]===200));assert.equal((await call("/api/org/555555555"))[1].savedNotes.length,1);
[status,rec]=await call("/api/org/033333333/update",{type:"profile",rev:1,requestId:code(),fields:{contactRole:"Executive director",candidate:"other@example.org",revenue:"0",period:"2026-01"}});
assert.equal(status,200);assert.equal(rec.contactRole,"Executive director");assert.equal(rec.candidate,"other@example.org");assert.equal(rec.revenue,"0");
assert.equal((await call("/api/org/033333333/update",{type:"profile",rev:2,requestId:code(),fields:{email:"bad"}}))[0],400);
console.log("Passed rich organization/contact creation, initial note atomicity, website domain/revenue normalization, first-call routing, validation, retries, concurrent creation, duplicate preservation and editing.");
