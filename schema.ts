import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
export const organizations = sqliteTable("organizations", {
  id: text().primaryKey(),
  name: text().notNull(),
  profile: text().notNull(),
  revision: integer().notNull().default(1),
});
export const entries = sqliteTable("entries", {
  id: text().primaryKey(),
  organization: text()
    .notNull()
    .references(() => organizations.id),
  kind: text().notNull(),
  stamp: text().notNull(),
  author: text().notNull(),
  body: text().notNull(),
});

export const crmUsers = sqliteTable("crm_users", {
  googleSub: text("google_sub").primaryKey(),
  email: text().notNull().unique(),
  name: text().notNull(),
  lastSeen: integer("last_seen").notNull(),
  hostedDomain: text("hosted_domain").notNull().default(""),
});
export const authSessions = sqliteTable("auth_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  googleSub: text("google_sub").notNull().references(() => crmUsers.googleSub),
  expires: integer().notNull(),
});
export const authFlows = sqliteTable("auth_flows", {
  stateHash: text("state_hash").primaryKey(),
  nonce: text().notNull(),
  verifier: text().notNull(),
  expires: integer().notNull(),
});
