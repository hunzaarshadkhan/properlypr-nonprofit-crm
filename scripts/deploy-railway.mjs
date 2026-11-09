import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";

// Uses the same authenticated source-upload endpoint as `railway up`.
// A browser-compatible User-Agent avoids the CLI's false auth rejection on this host.
const token = process.env.RAILWAY_API_TOKEN_FILE
  ? readFileSync(process.env.RAILWAY_API_TOKEN_FILE, "utf8").trim()
  : process.env.RAILWAY_API_TOKEN;
if (!token) throw Error("Set RAILWAY_API_TOKEN_FILE or RAILWAY_API_TOKEN privately.");
const path = ".local/railway-deployment.json";
const config = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
const projectId = process.env.RAILWAY_PROJECT_ID || config.projectId;
const environmentId = process.env.RAILWAY_ENVIRONMENT_ID || config.environmentId;
const serviceId = process.env.RAILWAY_SERVICE_ID || config.serviceId;
if (![projectId, environmentId, serviceId].every(v => typeof v === "string" && /^[a-f0-9-]{36}$/i.test(v)))
  throw Error("Set RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID and RAILWAY_SERVICE_ID, or use the saved .local deployment configuration.");
if (execFileSync("git", ["status", "--porcelain"], {encoding:"utf8"}).trim())
  throw Error("Commit changes first: only the committed HEAD is deployed.");
const source = execFileSync("git", ["archive", "--format=tar.gz", "HEAD"], {maxBuffer:25*1024*1024});
const url = new URL(`https://backboard.railway.com/project/${projectId}/environment/${environmentId}/up`);
url.searchParams.set("serviceId", serviceId);
url.searchParams.set("message", "ProperlyPR " + execFileSync("git", ["rev-parse", "HEAD"], {encoding:"utf8"}).trim());
const response = await fetch(url, {method:"POST", headers:{Authorization:"Bearer " + token, "Content-Type":"application/gzip", "User-Agent":"Mozilla/5.0"}, body:source, signal:AbortSignal.timeout(120000)});
if (!response.ok) throw Error(`Railway source upload failed (HTTP ${response.status}).`);
const deployment = await response.json();
mkdirSync(".local", {recursive:true});
writeFileSync(path, JSON.stringify({...config, projectId, environmentId, serviceId, deployment}, null, 2) + "\n");
console.log("Deployment submitted:", deployment.url);
if (deployment.deploymentDomain) console.log("Application:", "https://" + deployment.deploymentDomain);
console.log("Submission is not a health verdict. Check Railway deployment status and HTTPS /healthz before calling it live.");
