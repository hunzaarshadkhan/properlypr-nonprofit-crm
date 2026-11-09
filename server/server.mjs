import http from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { openDatabase } from "../dev/database.mjs";
import app from "../dist/server/index.js";
import { accessPolicy, beginLogin, consumeLogin, googleIdentity, makeSession, readSession, endSession } from "./auth.mjs";
import { createGoogleProvider } from "./google.mjs";

function loginPage(error = "", domain = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · ProperlyPR</title><style>body{font:16px/1.5 system-ui;background:#faf9f5;color:#183f34;max-width:400px;margin:10vh auto;padding:24px}.google{display:block;text-align:center;text-decoration:none;padding:12px;color:#1f1f1f;background:white;border:1px solid #747775;border-radius:6px;font:500 16px/1.5 Arial,sans-serif;margin:28px 0}p[role]{color:#9e2929}small{color:#56695f}</style></head><body><p>PROPERLYPR / TEAM WORKSPACE</p><h1>Welcome back</h1><p>${domain ? "Sign in with your @" + domain + " Google Workspace account." : "Sign in with your approved Google account to manage nonprofit outreach."}</p><p role="alert">${error}</p><a class="google" href="/auth/google">Continue with Google</a><small>${domain ? "Access is limited to " + domain + " team members." : "Access is limited to approved team members."}</small></body></html>`;
}

export function createCRMServer({ db, origin, allowedEmails, allowedDomain, google }) {
  const allowed = accessPolicy({allowedEmails, allowedDomain});
  if (!google || typeof google.authorizationUrl !== "function" || typeof google.verifyCode !== "function") throw Error("Configure Google OAuth before starting the CRM.");
  const base = new URL(origin);
  if (base.origin !== origin || !["http:","https:"].includes(base.protocol)) throw Error("APP_ORIGIN must be an http(s) origin without a trailing slash.");
  const secure = base.protocol === "https:";
  const cookieName = secure ? "__Host-crm" : "crm_session";
  const flowCookieName = secure ? "__Host-crm_oauth" : "crm_oauth";
  // Lax permits Google's top-level callback; Origin checks protect all application writes.
  const cookie = (name, token, maxAge) => `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  const renderLogin = error => loginPage(error, allowed.domain);
  const attempts = new Map();
  let totalAttempts = 0, windowStart = Date.now();
  const server = http.createServer(async (incoming, outgoing) => {
    const nonce = randomBytes(18).toString("base64");
    outgoing.setHeader("X-Content-Type-Options", "nosniff");
    outgoing.setHeader("Referrer-Policy", "no-referrer");
    outgoing.setHeader("X-Frame-Options", "DENY");
    outgoing.setHeader("Cache-Control", "private, no-store");
    outgoing.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
    if (secure) outgoing.setHeader("Strict-Transport-Security", "max-age=31536000");
    const send = (status, body, type = "text/plain; charset=utf-8") => { outgoing.writeHead(status, {"Content-Type":type}); outgoing.end(body); };
    const redirect = path => { outgoing.writeHead(303, {Location:path}); outgoing.end(); };
    try {
      if (!incoming.url.startsWith("/") || incoming.url.startsWith("//")) return send(400, "Invalid path.");
      const url = new URL(incoming.url, origin), path = url.pathname;
      if (incoming.method === "GET" && path === "/healthz") {
        await db.prepare("SELECT 1 FROM organizations LIMIT 1").all();
        return send(200, '{"ok":true}', "application/json");
      }
      if (incoming.headers.host !== base.host) return send(400, "Invalid host.");
      if (!["GET", "POST"].includes(incoming.method)) return send(405, "Unsupported method.");
      if (incoming.method === "POST" && incoming.headers.origin !== origin) return send(403, "Invalid request origin.");
      const getCookie = name => (incoming.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith(name + "="))?.slice(name.length + 1);
      const token = getCookie(cookieName);
      if (path === "/login") {
        if (incoming.method !== "GET") return send(405, "Use Continue with Google to sign in.");
        if (await readSession(db, token, allowed)) return redirect("/");
        return send(200, renderLogin(), "text/html; charset=utf-8");
      }
      if (path === "/auth/google" && incoming.method === "GET") {
        const now = Date.now();
        if (now - windowStart > 15*60*1000) { windowStart = now; totalAttempts = 0; attempts.clear(); }
        const ip = incoming.headers["x-forwarded-for"]?.split(",").at(-1)?.trim() || incoming.socket.remoteAddress;
        const count = attempts.get(ip) || 0;
        if (count >= 20 || totalAttempts >= 500) { outgoing.setHeader("Retry-After", "900"); return send(429, "Too many sign-in attempts. Try again in 15 minutes."); }
        totalAttempts++; attempts.set(ip, count + 1);
        const flow = await beginLogin(db);
        outgoing.setHeader("Set-Cookie", cookie(flowCookieName, flow.state, 600));
        return redirect(google.authorizationUrl({...flow, hostedDomain:allowed.domain}));
      }
      if (path === "/auth/google/callback" && incoming.method === "GET") {
        outgoing.setHeader("Set-Cookie", cookie(flowCookieName, "", 0));
        const state = url.searchParams.getAll("state");
        const flow = state.length === 1 ? await consumeLogin(db, state[0], getCookie(flowCookieName)) : null;
        if (!flow) return send(400, renderLogin("This sign-in request expired or is invalid. Please try again."), "text/html; charset=utf-8");
        if (url.searchParams.has("error")) return send(401, renderLogin("Google sign-in was cancelled. You can try again."), "text/html; charset=utf-8");
        const codes = url.searchParams.getAll("code");
        if (codes.length !== 1 || !codes[0] || codes[0].length > 4096) return send(400, renderLogin("Google did not return a valid sign-in response. Please try again."), "text/html; charset=utf-8");
        try {
          const claims = await google.verifyCode(codes[0], flow.verifier);
          const identity = googleIdentity(claims, flow.nonce, allowed);
          if (!identity) return send(403, renderLogin(allowed.domain ? "Use a verified @" + allowed.domain + " Google Workspace account to sign in." : "This Google account is not approved. Use an approved Gmail or Google Workspace account, or ask your CRM administrator for access."), "text/html; charset=utf-8");
          const session = await makeSession(db, identity);
          if (!session) return send(403, renderLogin("This account needs an administrator to review its identity before sign-in."), "text/html; charset=utf-8");
          await endSession(db, token);
          outgoing.setHeader("Set-Cookie", [cookie(flowCookieName, "", 0), cookie(cookieName, session, 28800)]);
          return redirect("/");
        } catch {
          // OAuth library errors can contain the client secret or authorization code; never log them.
          console.error("Google sign-in verification failed.");
          return send(502, renderLogin("We couldn’t verify your Google sign-in. Please try again."), "text/html; charset=utf-8");
        }
      }
      if (path === "/logout" && incoming.method === "POST") {
        await endSession(db, token);
        outgoing.setHeader("Set-Cookie", [cookie(cookieName, "", 0), cookie(flowCookieName, "", 0)]);
        return redirect("/login");
      }
      const user = await readSession(db, token, allowed);
      if (!user) {
        if (path.startsWith("/api/")) return send(401, '{"error":"Sign in to open this workspace."}', "application/json");
        return redirect("/login");
      }
      const chunks = []; let length = 0;
      for await (const chunk of incoming) {
        length += chunk.length;
        if (length > 2*1024*1024) { send(413, "Request too large."); incoming.resume(); return; }
        chunks.push(chunk);
      }
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const headers = new Headers({"oai-authenticated-user-id":user.google_sub, "oai-authenticated-user-email":user.email});
      for (const key of ["content-type", "origin"]) if (incoming.headers[key]) headers.set(key, incoming.headers[key]);
      const response = await app.fetch(new Request(new URL(incoming.url, origin), {method:incoming.method, headers, body}), {DB:db});
      for (const [key, value] of response.headers) outgoing.setHeader(key, value);
      let output = Buffer.from(await response.arrayBuffer());
      if (response.headers.get("content-type")?.includes("text/html")) output = Buffer.from(output.toString().replaceAll("<script>", `<script nonce="${nonce}">`));
      outgoing.writeHead(response.status); outgoing.end(output);
    } catch {
      console.error("CRM request failed.");
      if (!outgoing.headersSent) send(500, "Unable to complete this request.");
      else outgoing.end();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const origin = process.env.APP_ORIGIN;
  if (!origin || (process.env.NODE_ENV === "production" && !origin.startsWith("https://"))) throw Error("Set APP_ORIGIN to the public HTTPS URL.");
  const filename = resolve(process.env.CRM_DATABASE_PATH || ".local/crm.sqlite");
  if (process.env.RAILWAY_ENVIRONMENT_ID) {
    const mount = process.env.RAILWAY_VOLUME_MOUNT_PATH;
    if (!mount || !filename.startsWith(resolve(mount) + sep)) throw Error("Mount a Railway volume and put CRM_DATABASE_PATH inside it.");
  }
  const google = createGoogleProvider({clientId:process.env.GOOGLE_CLIENT_ID, clientSecret:process.env.GOOGLE_CLIENT_SECRET, redirectUri:origin + "/auth/google/callback"});
  const allowedEmails = process.env.CRM_ALLOWED_EMAILS;
  const allowedDomain = process.env.CRM_ALLOWED_DOMAIN;
  accessPolicy({allowedEmails, allowedDomain});
  mkdirSync(dirname(filename), {recursive:true});
  const db = openDatabase(filename);
  const server = createCRMServer({db, origin, allowedEmails, allowedDomain, google});
  server.listen(Number(process.env.PORT || 8080), "0.0.0.0", () => console.log("ProperlyPR CRM listening; migrations applied; Google sign-in ready."));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(1), 10000).unref(); });
}
