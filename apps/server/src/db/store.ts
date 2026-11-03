import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Conversation } from "../shared/types.ts";

/** Persist full conversation state and decision traces atomically in a local SQLite database. */
export function openStore(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, state TEXT NOT NULL, updated INTEGER NOT NULL)",
  );
  const columns = db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[];
  if (!columns.some((c) => c.name === "session"))
    db.exec(
      "ALTER TABLE conversations ADD COLUMN session TEXT; CREATE INDEX IF NOT EXISTS conversations_session ON conversations (session, updated)",
    );
  return {
    list: (session: string) =>
      db
        .prepare(
          "SELECT id, title FROM conversations WHERE session = ? ORDER BY updated DESC LIMIT 100",
        )
        .all(session),
    get(id: string): Conversation | undefined {
      const row = db.prepare("SELECT state FROM conversations WHERE id = ?").get(id);
      return row ? JSON.parse(row.state as string) : undefined;
    },
    save(conversation: Conversation) {
      db.prepare(
        "INSERT INTO conversations (id, title, state, updated, session) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, state=excluded.state, updated=excluded.updated",
      ).run(
        conversation.id,
        conversation.title,
        JSON.stringify(conversation),
        Date.now(),
        conversation.session ?? null,
      );
    },
    close: () => db.close(),
  };
}
