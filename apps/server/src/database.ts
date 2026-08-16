import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataDirectory } from "./paths.js";

export type SqlValue = string | number | bigint | null | Uint8Array;

export class GameDatabase {
  readonly connection: DatabaseSync;

  constructor(path = process.env.DB_PATH ?? resolve(dataDirectory, "sanguo.db")) {
    mkdirSync(dirname(path), { recursive: true });
    this.connection = new DatabaseSync(path);
    this.connection.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate() {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        phase TEXT NOT NULL,
        auto_play INTEGER NOT NULL DEFAULT 0,
        state_json TEXT NOT NULL,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        game_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        phase TEXT NOT NULL,
        before_state_json TEXT NOT NULL,
        prepared_state_json TEXT NOT NULL,
        after_state_json TEXT,
        priority_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (game_id, turn),
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS turn_orders (
        game_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        faction_id TEXT NOT NULL,
        controller TEXT NOT NULL,
        model_id TEXT,
        status TEXT NOT NULL,
        decision_json TEXT,
        error TEXT,
        duration_ms INTEGER,
        attempts INTEGER,
        usage_json TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (game_id, turn, faction_id),
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS faction_memories (
        game_id TEXT NOT NULL,
        faction_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        memory TEXT NOT NULL,
        PRIMARY KEY (game_id, faction_id, turn),
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS game_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        type TEXT NOT NULL,
        faction_id TEXT,
        message TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_events_game_turn ON game_events(game_id, turn, id);
    `);
  }

  run(sql: string, parameters: SqlValue[] = []) {
    return this.connection.prepare(sql).run(...parameters);
  }

  get<T>(sql: string, parameters: SqlValue[] = []) {
    return this.connection.prepare(sql).get(...parameters) as T | undefined;
  }

  all<T>(sql: string, parameters: SqlValue[] = []) {
    return this.connection.prepare(sql).all(...parameters) as T[];
  }

  transaction<T>(callback: () => T): T {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }
}
