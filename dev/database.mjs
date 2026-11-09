import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function openDatabase(filename) {
  const sqlite = new DatabaseSync(filename);
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA busy_timeout = 5000");
  sqlite.exec("PRAGMA synchronous = FULL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS local_migrations (tag TEXT PRIMARY KEY)",
  );
  const folder = new URL("../drizzle/", import.meta.url);
  const { entries } = JSON.parse(
    readFileSync(new URL("meta/_journal.json", folder), "utf8"),
  );
  for (const { tag } of entries) {
    if (sqlite.prepare("SELECT tag FROM local_migrations WHERE tag=?").get(tag))
      continue;
    sqlite.exec("BEGIN");
    try {
      sqlite.exec(readFileSync(new URL(tag + ".sql", folder), "utf8"));
      sqlite.prepare("INSERT INTO local_migrations VALUES(?)").run(tag);
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  function prepare(sql, args = []) {
    const statement = sqlite.prepare(sql);
    return {
      bind(...params) {
        return prepare(sql, params);
      },
      first() {
        return statement.get(...args);
      },
      all() {
        return { results: statement.all(...args) };
      },
      run() {
        return { meta: statement.run(...args) };
      },
    };
  }
  return {
    prepare,
    close: () => sqlite.close(),
    batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const result = statements.map((statement) => statement.run());
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
