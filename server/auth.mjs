import { randomBytes, createHash } from "node:crypto";

const now = () => Math.floor(Date.now() / 1000);
const opaque = () => randomBytes(32).toString("base64url");
const hash = value => createHash("sha256").update(value).digest("hex");
const validOpaque = value => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);

export function approvedEmails(raw) {
  const emails = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  if (!emails.length || emails.length > 100 || emails.some(email => typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())))
    throw Error("Set CRM_ALLOWED_EMAILS to a comma-separated list of approved Google email addresses.");
  return new Set(emails.map(email => email.trim().toLowerCase()));
}

export function accessPolicy({allowedEmails, allowedDomain}) {
  if (allowedDomain) {
    const domain = typeof allowedDomain === "string" ? allowedDomain.trim().toLowerCase() : "";
    if (domain.length > 253 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain))
      throw Error("CRM_ALLOWED_DOMAIN must be an exact Google Workspace domain.");
    if ((Array.isArray(allowedEmails) && allowedEmails.length) || (typeof allowedEmails === "string" && allowedEmails.trim()))
      throw Error("Configure either CRM_ALLOWED_DOMAIN or CRM_ALLOWED_EMAILS, not both.");
    return {domain, emails:new Set()};
  }
  return {domain:"", emails:approvedEmails(allowedEmails)};
}

function hasAccess(email, hostedDomain, policy) {
  if (typeof email !== "string") return false;
  return policy.domain
    ? email.split("@").length === 2 && email.split("@")[1] === policy.domain && hostedDomain === policy.domain
    : policy.emails.has(email);
}

export async function beginLogin(db) {
  const state = opaque(), nonce = opaque(), verifier = opaque();
  await db.batch([
    db.prepare("DELETE FROM auth_flows WHERE expires<=?").bind(now()),
    db.prepare("DELETE FROM auth_sessions WHERE expires<=?").bind(now()),
    db.prepare("INSERT INTO auth_flows(state_hash,nonce,verifier,expires) VALUES(?,?,?,?)").bind(hash(state), nonce, verifier, now() + 600),
  ]);
  return {state, nonce, codeChallenge: createHash("sha256").update(verifier).digest("base64url")};
}

export async function consumeLogin(db, state, cookieState) {
  if (!validOpaque(state) || state !== cookieState) return null;
  // Delete atomically before exchanging the code: a callback can be used only once.
  return await db.prepare("DELETE FROM auth_flows WHERE state_hash=? AND expires>? RETURNING nonce,verifier").bind(hash(state), now()).first() || null;
}

export function googleIdentity(claims, nonce, allowed) {
  if (!claims || claims.nonce !== nonce || claims.email_verified !== true ||
      typeof claims.sub !== "string" || !/^[a-zA-Z0-9_-]{1,255}$/.test(claims.sub) ||
      typeof claims.email !== "string") return null;
  const email = claims.email.toLowerCase();
  const hostedDomain = typeof claims.hd === "string" ? claims.hd.toLowerCase() : "";
  if (!hasAccess(email, hostedDomain, allowed)) return null;
  // Google must be authoritative for the allowlisted email (Gmail or Workspace).
  if (!email.endsWith("@gmail.com") && !(typeof claims.hd === "string" && claims.hd)) return null;
  return {googleSub:claims.sub, email, hostedDomain, name:typeof claims.name === "string" ? claims.name.slice(0,240) : email};
}

export async function makeSession(db, identity) {
  const existing = await db.prepare("SELECT google_sub FROM crm_users WHERE email=?").bind(identity.email).first();
  if (existing && existing.google_sub !== identity.googleSub) return null;
  const token = opaque();
  await db.batch([
    db.prepare("INSERT INTO crm_users(google_sub,email,name,last_seen,hosted_domain) VALUES(?,?,?,?,?) ON CONFLICT(google_sub) DO UPDATE SET email=excluded.email,name=excluded.name,last_seen=excluded.last_seen,hosted_domain=excluded.hosted_domain")
      .bind(identity.googleSub, identity.email, identity.name, now(), identity.hostedDomain || ""),
    db.prepare("INSERT INTO auth_sessions(token_hash,google_sub,expires) VALUES(?,?,?)").bind(hash(token), identity.googleSub, now() + 28800),
  ]);
  return token;
}

export async function readSession(db, token, allowed) {
  if (!validOpaque(token)) return null;
  const user = await db.prepare("SELECT u.google_sub,u.email,u.name,u.hosted_domain FROM auth_sessions s JOIN crm_users u ON u.google_sub=s.google_sub WHERE s.token_hash=? AND s.expires>?").bind(hash(token), now()).first();
  return user && hasAccess(user.email, user.hosted_domain, allowed) ? user : null;
}

export async function endSession(db, token) {
  if (validOpaque(token)) await db.prepare("DELETE FROM auth_sessions WHERE token_hash=?").bind(hash(token)).run();
}
