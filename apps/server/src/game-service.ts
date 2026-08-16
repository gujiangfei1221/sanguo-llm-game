import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  buildObservation,
  createInitialState,
  listLegalActions,
  normalizeGameState,
  prepareTurn,
  resolveTurn,
  type ScenarioDefinition
} from "@sanguo/game-engine";
import { createHarness, type DecisionHarness } from "@sanguo/pi-harness";
import {
  audienceOrderSchema,
  controllerUpdateSchema,
  createGameSchema,
  humanOrderSchema,
  modelDecisionSchema,
  type FactionRuntimeConfig,
  type GameEvent,
  type GamePhase,
  type GameRuntimeConfig,
  type GameState,
  type ModelConfig,
  type ModelDecision
} from "@sanguo/shared";
import { GameDatabase } from "./database.js";
import { ReplayExporter } from "./replay-exporter.js";
import { autoRotateConfigPath, modelsPath, scenarioPath } from "./paths.js";

interface GameRow {
  id: string;
  name: string;
  phase: GamePhase;
  auto_play: number;
  state_json: string;
  config_json: string;
  created_at: string;
  updated_at: string;
}

interface OrderRow {
  faction_id: string;
  controller: string;
  model_id?: string;
  status: string;
  decision_json?: string;
  error?: string;
  duration_ms?: number;
  attempts?: number;
}

interface EventRow {
  id: number;
  turn: number;
  type: string;
  faction_id?: string;
  message: string;
  payload_json?: string;
}

type Listener = (event: { type: string; data: unknown }) => void;

const now = () => new Date().toISOString();
const parseJson = <T>(value: string): T => JSON.parse(value) as T;
const parseState = (value: string) => normalizeGameState(parseJson<GameState>(value));

export class GameService {
  readonly models: ModelConfig[];
  private readonly scenario: ScenarioDefinition;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly modelConcurrency = Math.max(1, Number(process.env.MODEL_CONCURRENCY ?? 3));
  private readonly autoRotate = process.env.AUTO_ROTATE === "1";
  private readonly autoRotateConfig: GameRuntimeConfig;
  private readonly replayExporter: ReplayExporter;
  private activeGameId?: string;

  constructor(private readonly database: GameDatabase, private readonly harness: DecisionHarness = createHarness()) {
    this.models = parseJson<ModelConfig[]>(readFileSync(modelsPath, "utf8"));
    this.scenario = parseJson<ScenarioDefinition>(readFileSync(scenarioPath, "utf8"));
    this.migrateStoredStates();
    this.recoverInterruptedGames();
    this.autoRotateConfig = this.loadAutoRotateConfig();
    this.replayExporter = new ReplayExporter(database);
    const liveTimer = setInterval(() => {
      try { this.replayExporter.updateLive(); } catch { /* 忽略快照失败 */ }
    }, 30000);
    liveTimer.unref?.();
    this.ensureAutoRotateRunning();
  }

  private loadAutoRotateConfig(): GameRuntimeConfig {
    const fallback: GameRuntimeConfig = {
      name: "群雄逐鹿",
      factions: [
        { factionId: "wei", controller: "model", modelId: "deepseek-v4-flash" },
        { factionId: "shu", controller: "model", modelId: "doubao-seed-2.0-lite" },
        { factionId: "wu", controller: "model", modelId: "glm-latest" }
      ]
    };
    if (!existsSync(autoRotateConfigPath)) return fallback;
    try {
      return createGameSchema.parse(parseJson<unknown>(readFileSync(autoRotateConfigPath, "utf8")));
    } catch {
      return fallback;
    }
  }

  private migrateStoredStates() {
    const games = this.database.all<{ id: string; state_json: string }>("SELECT id, state_json FROM games");
    for (const game of games) {
      const previous = parseJson<GameState>(game.state_json);
      const state = normalizeGameState(previous);
      if (!previous.director?.lastStandCounts) {
        const counts = this.database.all<{ faction_id: string; count: number }>("SELECT faction_id, COUNT(*) AS count FROM game_events WHERE game_id = ? AND type = 'director_last_stand' AND faction_id IS NOT NULL GROUP BY faction_id", [game.id]);
        state.director.lastStandCounts = Object.fromEntries(counts.map((item) => [item.faction_id, Math.min(2, item.count)]));
      }
      if (JSON.stringify(state) !== game.state_json) this.database.run("UPDATE games SET state_json = ? WHERE id = ?", [JSON.stringify(state), game.id]);
    }
  }

  private recoverInterruptedGames() {
    this.database.run("UPDATE games SET auto_play = 0 WHERE phase = 'FINISHED'");
    const unstable = ["PREPARING", "ORDERS_LOCKED", "RESOLVING", "PUBLISHING"];
    for (const phase of unstable) this.database.run("UPDATE games SET phase = 'BLOCKED', updated_at = ? WHERE phase = ?", [now(), phase]);
    const thinkingGames = this.database.all<{ game_id: string }>("SELECT DISTINCT game_id FROM turn_orders WHERE status = 'thinking'");
    for (const item of thinkingGames) {
      this.database.run("UPDATE turn_orders SET status = 'error', error = '服务重启导致调用中断', updated_at = ? WHERE game_id = ? AND status = 'thinking'", [now(), item.game_id]);
      this.database.run("UPDATE games SET phase = 'BLOCKED', updated_at = ? WHERE id = ?", [now(), item.game_id]);
    }
  }

  private ensureAutoRotateRunning() {
    if (!this.autoRotate) return;
    const active = this.database.get<GameRow>("SELECT * FROM games WHERE phase NOT IN ('FINISHED', 'DRAFT', 'BLOCKED') ORDER BY updated_at DESC LIMIT 1");
    if (active) {
      if (active.phase === "WAITING_TO_ADVANCE" && active.auto_play) void this.advance(active.id);
      return;
    }
    try {
      const created = this.createGame(this.autoRotateConfig);
      void this.advance(created.id);
    } catch (error) {
      console.error("[auto-rotate] 启动自动开新局失败：", error);
    }
  }

  private rotateToNextGame(finishedGameId: string) {
    try {
      const game = this.requireGame(finishedGameId);
      const config = parseJson<GameRuntimeConfig>(game.config_json);
      const count = this.database.get<{ c: number }>("SELECT COUNT(*) AS c FROM games")?.c ?? 0;
      const created = this.createGame({ ...config, name: `${config.name} #${count + 1}` });
      this.publish(finishedGameId, "auto_rotate", { nextGameId: created.id });
      void this.advance(created.id);
    } catch (error) {
      this.publish(finishedGameId, "error", { message: `自动开新局失败：${error instanceof Error ? error.message : String(error)}` });
    }
  }

  subscribe(gameId: string, listener: Listener) {
    const set = this.listeners.get(gameId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(gameId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(gameId);
    };
  }

  private publish(gameId: string, type: string, data: unknown) {
    for (const listener of this.listeners.get(gameId) ?? []) listener({ type, data });
  }

  listGames() {
    return this.database.all<GameRow>("SELECT * FROM games ORDER BY updated_at DESC").map((row) => this.toSummary(row));
  }

  createGame(input: unknown) {
    const parsed = createGameSchema.parse(input);
    const modelIds = new Set(this.models.map((model) => model.id));
    for (const faction of parsed.factions) {
      if (faction.controller === "model" && (!faction.modelId || !modelIds.has(faction.modelId))) throw new Error(`势力 ${faction.factionId} 的模型不在白名单中`);
    }
    const id = randomUUID();
    const state = createInitialState(this.scenario);
    const config: GameRuntimeConfig = parsed;
    const timestamp = now();
    this.database.run(
      "INSERT INTO games(id, name, phase, auto_play, state_json, config_json, created_at, updated_at) VALUES (?, ?, 'WAITING_TO_ADVANCE', ?, ?, ?, ?, ?)",
      [id, parsed.name, this.autoRotate ? 1 : 0, JSON.stringify(state), JSON.stringify(config), timestamp, timestamp]
    );
    this.replayExporter.updateLive();
    return this.getGame(id);
  }

  getGame(gameId: string) {
    const row = this.requireGame(gameId);
    const state = parseState(row.state_json);
    const config = parseJson<GameRuntimeConfig>(row.config_json);
    const visibleProposalFactionIds = new Set(config.factions.filter((item) => item.controller === "human").map((item) => item.factionId));
    const publicState = structuredClone(state);
    publicState.proposals = publicState.proposals.filter((proposal) => proposal.status !== "pending" || visibleProposalFactionIds.has(proposal.fromFactionId) || visibleProposalFactionIds.has(proposal.toFactionId));
    const events = this.getEvents(gameId, 100, state);
    const aliveFactionIds = new Set(state.factions.filter((faction) => faction.alive).map((faction) => faction.id));
    const orders = state.turn > 0 ? this.database.all<OrderRow>("SELECT faction_id, controller, model_id, status, error, duration_ms, attempts FROM turn_orders WHERE game_id = ? AND turn = ? ORDER BY faction_id", [gameId, state.turn]).filter((order) => aliveFactionIds.has(order.faction_id)) : [];
    const humanLegalActions: Record<string, unknown> = {};
    const legalActions: Record<string, unknown> = {};
    for (const faction of state.factions.filter((item) => item.alive)) legalActions[faction.id] = listLegalActions(state, faction.id);
    if (row.phase === "COLLECTING_ORDERS") {
      for (const faction of config.factions.filter((item) => item.controller === "human" && aliveFactionIds.has(item.factionId))) humanLegalActions[faction.factionId] = listLegalActions(state, faction.factionId);
    }
    const memories = row.phase === "FINISHED"
      ? this.database.all<{ faction_id: string; memory: string }>("SELECT faction_id, memory FROM faction_memories WHERE game_id = ? AND turn = (SELECT MAX(turn) FROM faction_memories m2 WHERE m2.game_id = faction_memories.game_id AND m2.faction_id = faction_memories.faction_id)", [gameId])
      : [];
    return {
      id: row.id,
      name: row.name,
      phase: row.phase,
      autoPlay: Boolean(row.auto_play),
      state: publicState,
      config,
      events,
      orders,
      humanLegalActions,
      legalActions,
      memories,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private toSummary(row: GameRow) {
    const state = parseState(row.state_json);
    return { id: row.id, name: row.name, phase: row.phase, turn: state.turn, winnerFactionId: state.winnerFactionId, updatedAt: row.updated_at };
  }

  private requireGame(gameId: string) {
    const row = this.database.get<GameRow>("SELECT * FROM games WHERE id = ?", [gameId]);
    if (!row) throw new Error("对局不存在");
    return row;
  }

  private setPhase(gameId: string, phase: GamePhase) {
    this.database.run("UPDATE games SET phase = ?, updated_at = ? WHERE id = ?", [phase, now(), gameId]);
    this.publish(gameId, "phase", { phase });
  }

  private saveState(gameId: string, state: GameState, phase?: GamePhase) {
    if (phase) this.database.run("UPDATE games SET state_json = ?, phase = ?, updated_at = ? WHERE id = ?", [JSON.stringify(state), phase, now(), gameId]);
    else this.database.run("UPDATE games SET state_json = ?, updated_at = ? WHERE id = ?", [JSON.stringify(state), now(), gameId]);
  }

  private localizeMessage(message: string, state: GameState) {
    return [...state.factions]
      .sort((a, b) => b.id.length - a.id.length)
      .reduce((localized, faction) => localized.replace(new RegExp(`\\b${faction.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), faction.name), message);
  }

  private insertEvents(gameId: string, events: GameEvent[], state: GameState) {
    const timestamp = now();
    for (const event of events) {
      const localizedEvent = { ...event, message: this.localizeMessage(event.message, state) };
      this.database.run("INSERT INTO game_events(game_id, turn, type, faction_id, message, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [gameId, localizedEvent.turn, localizedEvent.type, localizedEvent.factionId ?? null, localizedEvent.message, localizedEvent.payload ? JSON.stringify(localizedEvent.payload) : null, timestamp]);
      this.publish(gameId, "game_event", localizedEvent);
    }
  }

  private getEvents(gameId: string, limit: number, state: GameState) {
    return this.database.all<EventRow>("SELECT id, turn, type, faction_id, message, payload_json FROM game_events WHERE game_id = ? ORDER BY id DESC LIMIT ?", [gameId, limit]).reverse().map((row) => ({
      id: row.id,
      turn: row.turn,
      type: row.type,
      factionId: row.faction_id,
      message: this.localizeMessage(row.message, state),
      payload: row.payload_json ? parseJson<Record<string, unknown>>(row.payload_json) : undefined
    }));
  }

  async advance(gameId: string) {
    const game = this.requireGame(gameId);
    if (game.phase !== "WAITING_TO_ADVANCE") throw new Error("当前阶段不能开始下一回合");
    if (this.activeGameId && this.activeGameId !== gameId) throw new Error("已有其他对局正在调用模型");
    void this.startTurn(gameId);
    return { accepted: true };
  }

  private async startTurn(gameId: string) {
    this.activeGameId = gameId;
    try {
      this.setPhase(gameId, "PREPARING");
      const game = this.requireGame(gameId);
      const beforeState = parseState(game.state_json);
      const prepared = prepareTurn(beforeState);
      const timestamp = now();
      this.database.transaction(() => {
        this.database.run("INSERT OR REPLACE INTO turns(game_id, turn, phase, before_state_json, prepared_state_json, after_state_json, priority_json, created_at, updated_at) VALUES (?, ?, 'COLLECTING_ORDERS', ?, ?, NULL, ?, ?, ?)", [gameId, prepared.state.turn, JSON.stringify(beforeState), JSON.stringify(prepared.state), JSON.stringify(prepared.priority), timestamp, timestamp]);
        this.saveState(gameId, prepared.state, "COLLECTING_ORDERS");
        this.insertEvents(gameId, prepared.events, prepared.state);
      });
      await this.collectOrders(gameId);
    } catch (error) {
      this.setPhase(gameId, "BLOCKED");
      this.publish(gameId, "error", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (this.activeGameId === gameId) this.activeGameId = undefined;
    }
  }

  private latestMemory(gameId: string, factionId: string) {
    return this.database.get<{ memory: string }>("SELECT memory FROM faction_memories WHERE game_id = ? AND faction_id = ? ORDER BY turn DESC LIMIT 1", [gameId, factionId])?.memory ?? "";
  }

  private fallbackDecision(gameId: string, factionId: string, reason: string): ModelDecision {
    return { action: { type: "rest" }, diplomacy: { responses: [] }, secretIntent: "none", publicMessage: "", reasonSummary: reason, privateMemory: this.latestMemory(gameId, factionId) };
  }

  private submitFallbackOrder(gameId: string, turn: number, factionId: string, reason: string) {
    const decision = this.fallbackDecision(gameId, factionId, `模型调用失败，本回合自动休整：${reason}`);
    this.database.run("UPDATE turn_orders SET status = 'submitted', decision_json = ?, error = ?, updated_at = ? WHERE game_id = ? AND turn = ? AND faction_id = ?", [JSON.stringify(decision), reason, now(), gameId, turn, factionId]);
    this.publish(gameId, "order_status", { factionId, status: "submitted", fallback: true, error: reason });
  }

  private ensureOrder(gameId: string, turn: number, config: FactionRuntimeConfig) {
    this.database.run(
      "INSERT OR IGNORE INTO turn_orders(game_id, turn, faction_id, controller, model_id, status, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
      [gameId, turn, config.factionId, config.controller, config.modelId ?? null, now()]
    );
  }

  private recentPublicEvents(gameId: string, turn: number, state: GameState) {
    return this.database.all<EventRow>("SELECT id, turn, type, faction_id, message, payload_json FROM game_events WHERE game_id = ? AND turn >= ? ORDER BY id", [gameId, Math.max(0, turn - 3)]).map((row) => ({
      type: row.type,
      turn: row.turn,
      factionId: row.faction_id,
      message: this.localizeMessage(row.message, state),
      payload: row.payload_json ? parseJson<Record<string, unknown>>(row.payload_json) : undefined
    }));
  }

  private async collectOrders(gameId: string) {
    const game = this.requireGame(gameId);
    const state = parseState(game.state_json);
    const config = parseJson<GameRuntimeConfig>(game.config_json);
    const turnRow = this.database.get<{ priority_json: string }>("SELECT priority_json FROM turns WHERE game_id = ? AND turn = ?", [gameId, state.turn]);
    if (!turnRow) throw new Error("缺少当前回合快照");
    const priority = parseJson<string[]>(turnRow.priority_json);
    const recentEvents = this.recentPublicEvents(gameId, state.turn, state);

    const aliveFactionIds = new Set(state.factions.filter((faction) => faction.alive).map((faction) => faction.id));
    const activeFactionConfigs = config.factions.filter((faction) => aliveFactionIds.has(faction.factionId));
    for (const factionConfig of activeFactionConfigs) this.ensureOrder(gameId, state.turn, factionConfig);
    const modelQueue: FactionRuntimeConfig[] = [];
    for (const factionConfig of activeFactionConfigs) {
      const current = this.database.get<OrderRow>("SELECT * FROM turn_orders WHERE game_id = ? AND turn = ? AND faction_id = ?", [gameId, state.turn, factionConfig.factionId]);
      if (!current || current.status === "submitted") continue;
      if (factionConfig.controller === "human") continue;
      modelQueue.push(factionConfig);
    }

    let queueIndex = 0;
    const worker = async () => {
      while (queueIndex < modelQueue.length) {
        const factionConfig = modelQueue[queueIndex++];
        if (!factionConfig) return;
        if (!factionConfig.modelId) {
          this.submitFallbackOrder(gameId, state.turn, factionConfig.factionId, "未配置模型");
          continue;
        }
        this.database.run("UPDATE turn_orders SET status = 'thinking', error = NULL, updated_at = ? WHERE game_id = ? AND turn = ? AND faction_id = ?", [now(), gameId, state.turn, factionConfig.factionId]);
        this.publish(gameId, "order_status", { factionId: factionConfig.factionId, status: "thinking" });
        try {
          const observation = buildObservation(state, factionConfig.factionId, priority, recentEvents, this.latestMemory(gameId, factionConfig.factionId));
          const result = await this.harness.decide({ modelId: factionConfig.modelId, observation });
          const usage = result.usage || result.diagnostics ? { ...result.usage, _harness: result.diagnostics } : undefined;
          this.database.run("UPDATE turn_orders SET status = 'submitted', decision_json = ?, duration_ms = ?, attempts = ?, usage_json = ?, updated_at = ? WHERE game_id = ? AND turn = ? AND faction_id = ?", [JSON.stringify(result.decision), result.durationMs, result.attempts, usage ? JSON.stringify(usage) : null, now(), gameId, state.turn, factionConfig.factionId]);
          this.publish(gameId, "order_status", { factionId: factionConfig.factionId, status: "submitted", durationMs: result.durationMs });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.submitFallbackOrder(gameId, state.turn, factionConfig.factionId, message);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(this.modelConcurrency, modelQueue.length) }, () => worker()));
    const pending = this.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM turn_orders WHERE game_id = ? AND turn = ? AND status != 'submitted'", [gameId, state.turn])?.count ?? 0;
    if (pending > 0) {
      this.setPhase(gameId, "COLLECTING_ORDERS");
      return;
    }
    await this.finalizeTurn(gameId);
  }

  private async finalizeTurn(gameId: string) {
    this.setPhase(gameId, "ORDERS_LOCKED");
    const game = this.requireGame(gameId);
    const state = parseState(game.state_json);
    const turnRow = this.database.get<{ priority_json: string }>("SELECT priority_json FROM turns WHERE game_id = ? AND turn = ?", [gameId, state.turn]);
    if (!turnRow) throw new Error("缺少回合数据");
    const orders = this.database.all<OrderRow>("SELECT * FROM turn_orders WHERE game_id = ? AND turn = ?", [gameId, state.turn]);
    const decisions: Record<string, ModelDecision> = {};
    for (const order of orders) {
      if (!order.decision_json) throw new Error(`势力 ${order.faction_id} 尚未提交命令`);
      decisions[order.faction_id] = modelDecisionSchema.parse(parseJson<unknown>(order.decision_json));
    }
    this.setPhase(gameId, "RESOLVING");
    const result = resolveTurn(state, decisions, parseJson<string[]>(turnRow.priority_json));
    const intentNames = { none: "无隐秘意图", honor_promise: "准备守约", feint: "计划佯攻", separate_peace: "暗中寻求议和" } as const;
    const revealEvents: GameEvent[] = Object.entries(result.acceptedOrders).map(([factionId, decision]) => ({
      type: "decision_revealed",
      turn: state.turn,
      factionId,
      message: `${state.factions.find((faction) => faction.id === factionId)?.name ?? factionId}：${decision.publicMessage || "（无公开发言）"} 决策理由：${decision.reasonSummary}；密谋揭晓：${intentNames[decision.secretIntent]}`
    }));
    const phase: GamePhase = result.victory.finished ? "FINISHED" : "WAITING_TO_ADVANCE";
    this.database.transaction(() => {
      this.database.run("UPDATE turns SET phase = ?, after_state_json = ?, updated_at = ? WHERE game_id = ? AND turn = ?", [phase, JSON.stringify(result.state), now(), gameId, state.turn]);
      this.saveState(gameId, result.state, phase);
      if (phase === "FINISHED") this.database.run("UPDATE games SET auto_play = 0, updated_at = ? WHERE id = ?", [now(), gameId]);
      for (const [factionId, decision] of Object.entries(result.acceptedOrders)) {
        this.database.run("INSERT OR REPLACE INTO faction_memories(game_id, faction_id, turn, memory) VALUES (?, ?, ?, ?)", [gameId, factionId, state.turn, decision.privateMemory]);
      }
      this.insertEvents(gameId, [...revealEvents, ...result.events], result.state);
    });
    this.publish(gameId, "turn_complete", { turn: state.turn, phase, victory: result.victory });

    if (phase === "FINISHED") {
      this.replayExporter.writeReplay(gameId);
      if (this.autoRotate) setTimeout(() => this.rotateToNextGame(gameId), 1000);
    }
    this.replayExporter.updateLive();

    const refreshed = this.requireGame(gameId);
    const config = parseJson<GameRuntimeConfig>(refreshed.config_json);
    if (refreshed.auto_play && phase === "WAITING_TO_ADVANCE" && config.factions.every((item) => item.controller === "model")) {
      setTimeout(() => void this.advance(gameId).catch((error) => this.publish(gameId, "error", { message: error instanceof Error ? error.message : String(error) })), 1000);
    }
  }

  async submitHumanOrder(gameId: string, input: unknown) {
    const parsed = humanOrderSchema.parse(input);
    const game = this.requireGame(gameId);
    if (game.phase !== "COLLECTING_ORDERS") throw new Error("当前不等待人工命令");
    const state = parseState(game.state_json);
    const config = parseJson<GameRuntimeConfig>(game.config_json);
    const faction = config.factions.find((item) => item.factionId === parsed.factionId);
    if (faction?.controller !== "human") throw new Error("该势力当前不是人工控制");
    this.database.run("UPDATE turn_orders SET status = 'submitted', decision_json = ?, error = NULL, updated_at = ? WHERE game_id = ? AND turn = ? AND faction_id = ?", [JSON.stringify(parsed.decision), now(), gameId, state.turn, parsed.factionId]);
    this.publish(gameId, "order_status", { factionId: parsed.factionId, status: "submitted" });
    if (!this.activeGameId) {
      this.activeGameId = gameId;
      try {
        await this.collectOrders(gameId);
      } finally {
        this.activeGameId = undefined;
      }
    }
    return { accepted: true };
  }

  setAutoPlay(gameId: string, enabled: boolean) {
    this.requireGame(gameId);
    this.database.run("UPDATE games SET auto_play = ?, updated_at = ? WHERE id = ?", [enabled ? 1 : 0, now(), gameId]);
    this.publish(gameId, "auto_play", { enabled });
    if (enabled && this.requireGame(gameId).phase === "WAITING_TO_ADVANCE") void this.advance(gameId);
    return { enabled };
  }

  submitAudienceOrder(gameId: string, input: unknown) {
    const parsed = audienceOrderSchema.parse(input);
    const game = this.requireGame(gameId);
    if (game.phase === "FINISHED") throw new Error("对局已经结束");
    const state = parseState(game.state_json);
    const target = state.factions.find((faction) => faction.id === parsed.targetFactionId && faction.alive);
    if (!target) throw new Error("目标势力不存在或已经灭亡");
    if (parsed.type === "predict") {
      if (state.turn > 8) throw new Error("只能在前 8 回合预测胜者");
      state.audience.predictedWinnerFactionId = parsed.targetFactionId;
      state.audience.predictionTurn = state.turn;
    } else {
      if (state.audience.influence <= 0) throw new Error("本局密令次数已经用完");
      if (state.turn - state.audience.lastInterventionTurn < 4) throw new Error("密令仍在冷却，每 4 回合才能使用一次");
      if (parsed.type === "rumor") {
        if (parsed.secondaryFactionId === parsed.targetFactionId || !state.factions.some((faction) => faction.id === parsed.secondaryFactionId && faction.alive)) throw new Error("流言需要选择两个不同的存续势力");
      }
      state.audience.influence -= 1;
      state.audience.lastInterventionTurn = state.turn;
      state.audience.orders.push({ id: randomUUID(), submittedTurn: state.turn, type: parsed.type, targetFactionId: parsed.targetFactionId, secondaryFactionId: parsed.type === "rumor" ? parsed.secondaryFactionId : undefined, resolved: false });
    }
    this.saveState(gameId, state);
    this.publish(gameId, "audience", { accepted: true });
    return this.getGame(gameId);
  }

  updateController(gameId: string, factionId: string, input: unknown) {
    const update = controllerUpdateSchema.parse(input);
    const game = this.requireGame(gameId);
    if (game.phase !== "WAITING_TO_ADVANCE") throw new Error("只能在回合之间切换控制方式");
    if (update.controller === "model" && (!update.modelId || !this.models.some((model) => model.id === update.modelId))) throw new Error("模型不在白名单中");
    const config = parseJson<GameRuntimeConfig>(game.config_json);
    const faction = config.factions.find((item) => item.factionId === factionId);
    if (!faction) throw new Error("势力不存在");
    faction.controller = update.controller;
    faction.modelId = update.modelId;
    this.database.run("UPDATE games SET config_json = ?, auto_play = 0, updated_at = ? WHERE id = ?", [JSON.stringify(config), now(), gameId]);
    this.publish(gameId, "controller", { factionId, ...update });
    return this.getGame(gameId);
  }

  async retry(gameId: string, factionId: string) {
    const game = this.requireGame(gameId);
    const state = parseState(game.state_json);
    if (game.phase !== "BLOCKED") throw new Error("当前对局未被阻塞");
    this.database.run("UPDATE turn_orders SET status = 'pending', error = NULL, updated_at = ? WHERE game_id = ? AND turn = ? AND faction_id = ?", [now(), gameId, state.turn, factionId]);
    this.setPhase(gameId, "COLLECTING_ORDERS");
    if (!this.activeGameId) {
      this.activeGameId = gameId;
      try {
        await this.collectOrders(gameId);
      } finally {
        this.activeGameId = undefined;
      }
    }
    return { accepted: true };
  }

  async forceRest(gameId: string, factionId: string) {
    const game = this.requireGame(gameId);
    const state = parseState(game.state_json);
    if (game.phase !== "BLOCKED" && game.phase !== "COLLECTING_ORDERS") throw new Error("当前不能强制休整");
    const decision = this.fallbackDecision(gameId, factionId, "模型调用失败，本回合强制休整。");
    this.database.run("UPDATE turn_orders SET status = 'submitted', decision_json = ?, error = NULL, updated_at = ? WHERE game_id = ? AND turn = ? AND faction_id = ?", [JSON.stringify(decision), now(), gameId, state.turn, factionId]);
    this.setPhase(gameId, "COLLECTING_ORDERS");
    if (!this.activeGameId) {
      this.activeGameId = gameId;
      try {
        await this.collectOrders(gameId);
      } finally {
        this.activeGameId = undefined;
      }
    }
    return { accepted: true };
  }

  async resume(gameId: string) {
    const game = this.requireGame(gameId);
    if (game.phase !== "BLOCKED") throw new Error("当前对局无需恢复");
    this.setPhase(gameId, "COLLECTING_ORDERS");
    if (!this.activeGameId) {
      this.activeGameId = gameId;
      try {
        await this.collectOrders(gameId);
      } finally {
        this.activeGameId = undefined;
      }
    }
    return { accepted: true };
  }
}
