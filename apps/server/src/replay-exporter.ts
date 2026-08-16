import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { normalizeGameState } from "@sanguo/game-engine";
import type { GamePhase, GameRuntimeConfig, GameState } from "@sanguo/shared";
import type { GameDatabase } from "./database.js";
import { replaysDirectory } from "./paths.js";

interface GameRow {
  id: string;
  name: string;
  phase: GamePhase;
  state_json: string;
  config_json: string;
  created_at: string;
  updated_at: string;
}

interface TurnRow {
  turn: number;
  phase: GamePhase;
  after_state_json: string | null;
}

interface EventRow {
  id: number;
  turn: number;
  type: string;
  faction_id?: string;
  message: string;
  payload_json?: string;
}

export interface StoredEvent {
  id: number;
  turn: number;
  type: string;
  factionId?: string;
  message: string;
  payload?: Record<string, unknown>;
}

export interface ReplayTurn {
  turn: number;
  phase: GamePhase;
  state: GameState;
  events: StoredEvent[];
}

export interface ReplayGame {
  id: string;
  name: string;
  createdAt: string;
  finishedAt: string;
  turnCount: number;
  winnerFactionId?: string;
  finishReason?: string;
  config: GameRuntimeConfig;
  turns: ReplayTurn[];
}

export interface ReplayManifestEntry {
  id: string;
  name: string;
  turn: number;
  winnerFactionId?: string;
  createdAt: string;
  finishedAt: string;
}

export interface LiveSnapshot {
  idle?: boolean;
  id: string;
  name: string;
  phase: GamePhase;
  turn: number;
  state: GameState;
  config: GameRuntimeConfig;
  events: StoredEvent[];
  createdAt: string;
  updatedAt: string;
  exportedAt: string;
}

const parseJson = <T>(value: string): T => JSON.parse(value) as T;
const LIVE_EVENT_LIMIT = 120;
const idPattern = /^[0-9a-f-]{8,}$/i;

export class ReplayExporter {
  private readonly keepMax = Math.max(5, Number(process.env.REPLAY_KEEP_MAX ?? 50));

  constructor(private readonly database: GameDatabase) {
    mkdirSync(replaysDirectory, { recursive: true });
  }

  private mapEvent(row: EventRow): StoredEvent {
    return {
      id: row.id,
      turn: row.turn,
      type: row.type,
      factionId: row.faction_id,
      message: row.message,
      payload: row.payload_json ? parseJson<Record<string, unknown>>(row.payload_json) : undefined
    };
  }

  /** 全量重导出：所有已结束对局 + 索引 + 当前直播快照 */
  exportAll() {
    const games = this.database.all<GameRow>("SELECT id, phase FROM games");
    for (const game of games) {
      if (game.phase === "FINISHED") this.writeReplay(game.id);
    }
    this.writeIndex();
    this.updateLive();
  }

  /** 导出某个对局的完整回放（仅已结束） */
  writeReplay(gameId: string): boolean {
    const row = this.database.get<GameRow>("SELECT * FROM games WHERE id = ?", [gameId]);
    if (!row || row.phase !== "FINISHED") return false;
    const config = parseJson<GameRuntimeConfig>(row.config_json);
    const turnRows = this.database.all<TurnRow>("SELECT turn, phase, after_state_json FROM turns WHERE game_id = ? AND after_state_json IS NOT NULL ORDER BY turn", [gameId]);
    const eventRows = this.database.all<EventRow>("SELECT id, turn, type, faction_id, message, payload_json FROM game_events WHERE game_id = ? ORDER BY id", [gameId]);
    const eventsByTurn = new Map<number, StoredEvent[]>();
    for (const event of eventRows) {
      const list = eventsByTurn.get(event.turn) ?? [];
      list.push(this.mapEvent(event));
      eventsByTurn.set(event.turn, list);
    }
    const turns: ReplayTurn[] = turnRows.map((turn) => ({
      turn: turn.turn,
      phase: turn.phase,
      state: normalizeGameState(parseJson<GameState>(turn.after_state_json!)),
      events: eventsByTurn.get(turn.turn) ?? []
    }));
    const lastState = turns.length ? turns[turns.length - 1]!.state : normalizeGameState(parseJson<GameState>(row.state_json));
    const replay: ReplayGame = {
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      finishedAt: row.updated_at,
      turnCount: turns.length,
      winnerFactionId: lastState.winnerFactionId,
      finishReason: lastState.finishReason,
      config,
      turns
    };
    writeFileSync(join(replaysDirectory, `${gameId}.json`), JSON.stringify(replay));
    return true;
  }

  /** 导出当前进行中对局的近实时快照 live.json */
  updateLive(): boolean {
    const active = this.database.get<GameRow>("SELECT * FROM games WHERE phase != 'FINISHED' ORDER BY updated_at DESC LIMIT 1");
    if (!active) {
      writeFileSync(join(replaysDirectory, "live.json"), JSON.stringify({ idle: true, updatedAt: new Date().toISOString(), exportedAt: new Date().toISOString() }));
      return false;
    }
    const state = normalizeGameState(parseJson<GameState>(active.state_json));
    const config = parseJson<GameRuntimeConfig>(active.config_json);
    const events = this.database.all<EventRow>("SELECT id, turn, type, faction_id, message, payload_json FROM game_events WHERE game_id = ? ORDER BY id DESC LIMIT ?", [active.id, LIVE_EVENT_LIMIT])
      .reverse()
      .map((event) => this.mapEvent(event));
    const live: LiveSnapshot = {
      id: active.id,
      name: active.name,
      phase: active.phase,
      turn: state.turn,
      state,
      config,
      events,
      createdAt: active.created_at,
      updatedAt: active.updated_at,
      exportedAt: new Date().toISOString()
    };
    writeFileSync(join(replaysDirectory, "live.json"), JSON.stringify(live));
    return true;
  }

  /** 维护 replays/index.json 战报清单，并清理超龄回放文件 */
  writeIndex() {
    const games = this.database.all<GameRow>("SELECT * FROM games WHERE phase = 'FINISHED' ORDER BY updated_at DESC");
    const kept = games.slice(0, this.keepMax);
    const entries: ReplayManifestEntry[] = kept.map((game) => {
      const state = parseJson<GameState>(game.state_json);
      return {
        id: game.id,
        name: game.name,
        turn: state.turn,
        winnerFactionId: state.winnerFactionId,
        createdAt: game.created_at,
        finishedAt: game.updated_at
      };
    });
    writeFileSync(join(replaysDirectory, "index.json"), JSON.stringify(entries));
    // 清理不在清单中的回放文件
    const keepIds = new Set(entries.map((entry) => entry.id));
    if (existsSync(replaysDirectory)) {
      for (const file of readdirSync(replaysDirectory)) {
        const match = file.match(/^([0-9a-f-]+)\.json$/i);
        if (!match) continue;
        const gameId = match[1]!;
        if (idPattern.test(gameId) && !keepIds.has(gameId)) {
          try { rmSync(join(replaysDirectory, file), { force: true }); } catch { /* 忽略 */ }
        }
      }
    }
  }
}
