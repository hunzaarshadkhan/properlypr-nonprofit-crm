import { csvFields, csvDestinations, parseCSV, csvDocument } from "./csv.js";

export async function csvImport(db, payload, author, day, commit = false) {
  const { text, mapping, destination = "Available", filename = "upload.csv", requestId } = payload;
  if (!csvDestinations.includes(destination)) throw Error("Choose a supported destination queue.");
  if (typeof filename !== "string" || filename.length > 240) throw Error("Invalid filename.");
  if (commit && (typeof requestId !== "string" || !/^[\da-f-]{36}$/i.test(requestId))) throw Error("Invalid import identifier.");
  const { headers, rows } = parseCSV(text);
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) throw Error("Map the organization and EIN columns.");
  const used = new Set();
  for (const [key, index] of Object.entries(mapping)) {
    if (!Object.hasOwn(csvFields, key)) throw Error("Unknown mapping field.");
    if (index === "") continue;
    if (!/^\d+$/.test(String(index)) || Number(index) >= headers.length || used.has(Number(index)))
      throw Error("Each mapped column must be valid and used only once.");
    used.add(Number(index));
  }
  if (mapping.name == null || mapping.name === "" || mapping.id == null || mapping.id === "") throw Error("Map organization name and EIN before continuing.");
  const { results } = await db.prepare("SELECT id FROM organizations").all();
  const existing = new Set(results.map(r => r.id));
  const seen = new Set(), errors = [], records = [], preview = [];
  let skipped = 0;
  const stamp = new Date().toISOString();
  rows.forEach((row, i) => {
    const o = Object.fromEntries(Object.entries(mapping).filter(([, n]) => n !== "").map(([k, n]) => [k, row[Number(n)].trim()]));
    o.id = o.id.replace(/[- ]/g, "");
    const problems = [];
    if (!/^\d{9}$/.test(o.id)) problems.push("EIN must contain nine digits; preserve leading zeros");
    if (!o.name || o.name.length > 240) problems.push("organization name is required (max 240 characters)");
    for (const [k, v] of Object.entries(o)) {
      if (v.length > 4500) problems.push(csvFields[k][0] + " is too long");
      if (k === "email" && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) problems.push("working email is invalid");
      if (["website", "researchSource"].includes(k) && v) {
        try {
          const u = new URL(v);
          if (!["http:", "https:"].includes(u.protocol)) throw Error();
          if (k === "website") o.domain = u.hostname.replace(/^www\./, "");
        } catch { problems.push(csvFields[k][0] + " must be a full http(s) URL"); }
      }
    }
    if (o.allowed && !["yes", "no", "unknown"].includes(o.allowed.toLowerCase())) problems.push("email permission must be Yes, No, or Unknown");
    if (o.allowed) o.allowed = o.allowed[0].toUpperCase() + o.allowed.slice(1).toLowerCase();
    if (o.revenue) {
      o.revenue = o.revenue.replace(/[$,]/g, "");
      if (!/^\d+(\.\d{1,2})?$/.test(o.revenue)) problems.push("reported revenue must be a nonnegative amount");
    }
    const duplicate = existing.has(o.id) || seen.has(o.id);
    seen.add(o.id);
    if (problems.length) errors.push({ row: i + 2, name: o.name, message: problems.join("; ") });
    else if (duplicate) skipped++;
    else {
      const routes = {
        "Available": ["Available", "Available", "Select for first call", ""],
        "First call": ["First call", "Awaiting first call", "Make first call", day],
        "Contact review": ["Review and Nurture", "Contact review", "Verify number or dialer", day],
        "Review": ["Review and Nurture", "Review", "Review imported record", day],
        "Nurture": ["Review and Nurture", "Nurture", "Review nurture", day],
        "Do not contact": ["Review and Nurture", "Do not contact", "Stopped", ""],
      };
      const [tab, status, step, due] = routes[destination];
      Object.assign(o, { tab, status, step, due, people: [], notes: [],
        importSource: { filename, row: i + 2, importedAt: stamp, batchId: requestId, values: Object.fromEntries(headers.map((h, n) => [h, row[n]])) },
        history: [{ date: stamp, text: "Organization imported", by: author, source: "csv-import", notes: filename + " · data row " + (i + 1) + ". No outreach recorded.", requestId }],
      });
      records.push(o);
    }
    if (preview.length < 8) preview.push({ row: i + 2, name: o.name, id: o.id, contact: o.contact || "", result: problems.length ? "Needs correction" : duplicate ? "Skip duplicate EIN" : destination });
  });
  const result = { total: rows.length, ready: records.length, skipped, errors, preview };
  if (!commit) return result;
  if (errors.length) throw Error("Correct all " + errors.length + " invalid rows before importing. No records were added.");
  const writes = records.map(o => db.prepare("INSERT OR IGNORE INTO organizations(id,name,profile) VALUES(?,?,?)").bind(o.id, o.name, JSON.stringify(o)));
  const saved = writes.length ? await db.batch(writes) : [];
  const added = saved.reduce((n, r) => n + Number(r.meta.changes), 0);
  return { total: rows.length, added, skipped: rows.length - added };
}

export async function csvExport(db, ids) {
  if (!Array.isArray(ids) || ids.length > 10000 || ids.some(id => typeof id !== "string" || !/^\d{9}$/.test(id))) throw Error("Choose a valid view to export (up to 10,000 records).");
  const selected = new Set(ids);
  const { results } = await db.prepare("SELECT profile FROM organizations ORDER BY name").all();
  const fields = [...Object.keys(csvFields), "tab", "status", "step", "due", "agreed"];
  const labels = [...Object.values(csvFields).map(v => v[0]), "Work tab", "Status", "Next step", "Due date", "Agreed time (ET)"];
  return csvDocument([labels, ...results.map(r => JSON.parse(r.profile)).filter(o => selected.has(o.id)).map(o => fields.map(k => o[k] ?? ""))]);
}
