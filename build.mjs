import { existsSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const source = (path) => readFileSync(path, "utf8");
function inlineModule(contents, path, replacement) {
  const line = contents
    .split("\n")
    .find((line) => line.startsWith("import ") && line.includes(path));
  if (!line) throw new Error("Missing import for " + path);
  return contents.replace(line, () => replacement);
}
const cadence = source("cadence.js").replace(/^export /gm, "");
const workflow = inlineModule(
  source("workflow.js"),
  "./cadence.js",
  cadence,
).replace(/^export /gm, "");
const csv = source("csv.js").replace(/^export /gm, "");
const csvApi = inlineModule(source("csv-api.js"), "./csv.js", csv).replace(/^export /gm, "");
const worker = inlineModule(inlineModule(source("worker.js"), "./workflow.js", workflow), "./csv-api.js", csvApi);
const htmlSlot = /\/\*\s*APP_HTML\s*\*\/\s*null/;
if (!htmlSlot.test(worker)) throw new Error("Missing HTML slot in Worker");
mkdirSync("dist/server", { recursive: true });
mkdirSync("dist/.openai", { recursive: true });
writeFileSync(
  "dist/server/index.js",
  worker.replace(htmlSlot, () => JSON.stringify(source("index.html").replace("/*CSV_MODULE*/", () => csv))),
);
if (existsSync(".openai/hosting.json")) copyFileSync(".openai/hosting.json", "dist/.openai/hosting.json");
