export const csvFields = {
  name: ["Organization", "organization name", "nonprofit", "company", "company name"],
  id: ["EIN", "tax id", "ein number"],
  contact: ["Person name", "contact", "contact name", "primary contact", "person"],
  contactRole: ["Contact role", "job title", "contact title"],
  phone: ["Phone", "phone number", "telephone"],
  email: ["Working email", "email", "crm email", "email address"],
  candidate: ["Published email candidate", "candidate email"],
  allowed: ["Email allowed?", "email allowed", "permission"],
  permissionEvidence: ["Permission evidence", "permission context"],
  website: ["Website", "website url", "url"],
  domain: ["Domain"],
  address: ["Mailing address", "address"],
  owner: ["Assigned rep", "rep", "owner"],
  focus: ["Focus area", "focus"],
  mission: ["Mission / programs", "mission"],
  revenue: ["Reported revenue (USD)", "reported revenue", "revenue"],
  period: ["Tax period", "period"],
  research: ["Research notes", "research"],
  researchSource: ["Research source", "research source url"],
};
export const csvDestinations = ["Available", "First call", "Contact review", "Review", "Nurture", "Do not contact"];
export function parseCSV(text) {
  if (typeof text !== "string" || text.length > 1500000) throw Error("Choose a CSV smaller than 1.5 MB.");
  text = text.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [], cell = "", quoted = false, closed = false;
  function field() { row.push(cell); cell = ""; closed = false; }
  function line() {
    field();
    if (row.some(v => v !== "")) rows.push(row);
    row = [];
    if (rows.length > 1001) throw Error("Import at most 1,000 records per file.");
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else { quoted = false; closed = true; }
      } else cell += c;
    } else if (c === ',' ) field();
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      line();
    } else if (c === '"' && !cell && !closed) quoted = true;
    else {
      if (closed || c === '"') throw Error("Invalid CSV quoting. Export as comma-separated CSV.");
      cell += c;
    }
    if (row.length > 60 || cell.length > 6000) throw Error("Use at most 60 columns and 6,000 characters per cell.");
  }
  if (quoted) throw Error("A quoted CSV field is missing its closing quote.");
  line();
  if (rows.length < 2) throw Error("Include a header row and at least one record.");
  const headers = rows.shift().map(v => v.trim());
  if (headers.length > 60 || headers.some(v => !v) || new Set(headers.map(v => v.toLowerCase())).size !== headers.length)
    throw Error("Column headers must be nonempty and unique (at most 60 columns).");
  if (rows.some(r => r.length !== headers.length)) throw Error("Every CSV row must have the same number of columns as the header.");
  return { headers, rows };
}
export function autoMap(headers) {
  const normalize = v => v.toLowerCase().replace(/[^a-z0-9]/g, "");
  return Object.fromEntries(Object.entries(csvFields).map(([key, aliases]) => {
    const matches = headers.map((h, i) => aliases.map(normalize).includes(normalize(h)) ? i : -1).filter(i => i >= 0);
    return [key, matches.length === 1 ? String(matches[0]) : ""];
  }));
}
export function csvCell(value) {
  let text = String(value ?? "");
  // Prevent spreadsheet applications from interpreting untrusted values as formulas.
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
export function csvDocument(rows) {
  return "\uFEFF" + rows.map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
