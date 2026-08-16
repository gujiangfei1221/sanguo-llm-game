import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { listLegalActions } from "@sanguo/game-engine";
import type { LegalAction } from "@sanguo/shared";
import type { GamePhase, GameRuntimeConfig, GameState } from "@sanguo/shared";
import { actionDetail, actionName, actionTouchesCity, cityPositions, eventCategory, eventCategoryName, factionNames, phaseNames, specializationNames } from "./App";

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
  createdAt?: string;
  finishedAt?: string;
}

export interface LiveSnapshot {
  idle?: boolean;
  id?: string;
  name?: string;
  phase?: GamePhase;
  turn?: number;
  state?: GameState;
  config?: GameRuntimeConfig;
  events?: StoredEvent[];
  createdAt?: string;
  updatedAt?: string;
  exportedAt?: string;
}

async function fetchStatic<T>(path: string, bust = false): Promise<T> {
  const url = `${import.meta.env.BASE_URL}${path}${bust ? `?t=${Date.now()}` : ""}`;
  const response = await fetch(url, { cache: bust ? "no-store" : "default" });
  if (!response.ok) throw new Error(`加载失败：${response.status}`);
  return response.json() as Promise<T>;
}

function timeAgo(iso?: string) {
  if (!iso) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return `${Math.floor(seconds / 3600)} 小时前`;
}

function fmtTime(iso?: string) {
  if (!iso) return "";
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function timeRange(startIso?: string, endIso?: string) {
  if (!startIso) return "";
  const start = fmtTime(startIso);
  if (!endIso) return start;
  const end = fmtTime(endIso);
  if (start.slice(0, 5) === end.slice(0, 5)) return `${start} -> ${end.slice(6)}`;
  return `${start} -> ${end}`;
}

export function WatchHome({ onOpenLive, onOpenReplay }: { onOpenLive: () => void; onOpenReplay: (id: string) => void }) {
  const [replays, setReplays] = useState<ReplayManifestEntry[]>();
  const [live, setLive] = useState<LiveSnapshot>();
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [list, current] = await Promise.all([
        fetchStatic<ReplayManifestEntry[]>("replays/index.json"),
        fetchStatic<LiveSnapshot>("replays/live.json", true)
      ]);
      setReplays(list);
      setLive(current);
      setError("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <main className="app-shell">
      <header className="masthead">
        <div><p className="eyebrow">LLM THREE KINGDOMS</p><h1>三国大模型回合战</h1></div>
        <p className="muted watch-subtitle">全自动推演 · 真模型三方对战 · 战报自动发布</p>
      </header>
      {error && <div className="error-banner" onClick={() => void load()}>{error}（点击重试）</div>}
      <div className="home-grid">
        <section className="panel create-panel">
          <h2>正在直播</h2>
          {!live
            ? <p className="muted">加载中……</p>
            : live.idle
              ? <p className="muted">当前没有进行中的对局。</p>
              : <div className="live-card">
                  <div className="live-card-head"><span className="live-dot" />正在直播</div>
                  <strong>{live.name}</strong>
                  <p>第 {live.turn} 回合 · {phaseNames[live.phase!]} · 开始于 {fmtTime(live.createdAt)}</p>
                  <button className="primary" onClick={onOpenLive}>观看直播</button>
                </div>}
          <div className="section-label">历史战报（{replays?.length ?? 0} 局）</div>
          {replays && replays.length === 0 && <p className="muted">还没有已结束的对局。</p>}
          {replays?.map((game) => (
            <button className="game-row" key={game.id} onClick={() => onOpenReplay(game.id)}>
              <span>
                <strong>{game.name}</strong>
                <small>第 {game.turn} 回合 · {game.winnerFactionId ? `${factionNames[game.winnerFactionId] ?? game.winnerFactionId}胜` : "未分胜负"}</small>
                <small className="game-times">{timeRange(game.createdAt, game.finishedAt)}</small>
              </span>
              <span>观看回放</span>
            </button>
          ))}
        </section>
        <section className="panel history-panel">
          <h2>关于本站</h2>
          <p className="muted">魏、蜀、吴三方由真实大模型自动决策，一局结束自动开启下一局。访客可实时围观最新战局（快照约每分钟更新），或回看任意已结束对局的完整过程。</p>
          <div className="section-label">对局阶段</div>
          <p className="muted">1–8 回合蓄势、9–18 回合争锋、19 回合起决战，一统九城者胜。</p>
        </section>
      </div>
    </main>
  );
}

interface WatchGame {
  name: string;
  phase: GamePhase;
  turn: number;
  state: GameState;
  config: GameRuntimeConfig;
  events: StoredEvent[];
}

export function WatchBoard({ game, onClose, extra }: { game: WatchGame; onClose?: () => void; extra?: ReactNode }) {
  const [selectedCityId, setSelectedCityId] = useState("chengdu");
  const [mobileView, setMobileView] = useState<"map" | "factions" | "events" | "decision">("map");

  const cityNames = Object.fromEntries(game.state.cities.map((city) => [city.id, city.name]));
  const selectedCity = game.state.cities.find((city) => city.id === selectedCityId) ?? game.state.cities[0]!;
  const selectedFaction = game.state.factions.find((faction) => faction.id === selectedCity.ownerFactionId)!;
  const selectedRuntime = game.config.factions.find((item) => item.factionId === selectedFaction.id);
  const selectedSieges = game.state.sieges.filter((siege) => siege.targetCityId === selectedCity.id);
  const currentStage = game.turn <= 8 ? "MUSTER" : game.turn <= 18 ? "CONTEST" : "DECISIVE";
  const edges = game.state.cities.flatMap((city) => city.adjacentCityIds.filter((targetId) => city.id < targetId).map((targetId) => [city.id, targetId] as const));
  const attackIndicators = [...new Map(game.events.filter((event) => event.turn === game.turn && (event.type === "attack_repulsed" || event.type === "city_captured") && typeof event.payload?.sourceCityId === "string" && typeof event.payload?.targetCityId === "string").map((event) => [`${event.payload!.sourceCityId}-${event.payload!.targetCityId}`, { sourceCityId: event.payload!.sourceCityId as string, targetCityId: event.payload!.targetCityId as string, troops: Number(event.payload!.troops ?? 0) }])).values()];
  const transferIndicators = game.events.filter((event) => event.turn === game.turn && event.type === "transfer" && typeof event.factionId === "string" && typeof event.payload?.sourceCityId === "string" && typeof event.payload?.targetCityId === "string").map((event) => ({ factionId: event.factionId!, sourceCityId: event.payload!.sourceCityId as string, targetCityId: event.payload!.targetCityId as string, troops: Number(event.payload!.troops ?? 0) }));
  const legalActions = useMemo(() => {
    const map: Record<string, LegalAction[]> = {};
    for (const faction of game.state.factions) if (faction.alive) map[faction.id] = listLegalActions(game.state, faction.id);
    return map;
  }, [game.state]);
  const cityActions = (legalActions[selectedCity.ownerFactionId] ?? []).filter((action) => actionTouchesCity(action, selectedCity.id));
  const bookkeepingEvents = new Set(["turn_prepared", "resource_overflow", "administration_paid"]);
  const visibleEvents = [...game.events].reverse().filter((event) => !bookkeepingEvents.has(event.type)).slice(0, 60);
  const eventGroups = visibleEvents.reduce<Array<{ turn: number; events: StoredEvent[] }>>((groups, event) => {
    const group = groups.find((item) => item.turn === event.turn);
    if (group) group.events.push(event);
    else groups.push({ turn: event.turn, events: [event] });
    return groups;
  }, []);

  const chooseFaction = (factionId: string) => {
    const capital = game.state.factions.find((faction) => faction.id === factionId)?.capitalCityId;
    const city = game.state.cities.find((item) => item.ownerFactionId === factionId && item.id === capital) ?? game.state.cities.find((item) => item.ownerFactionId === factionId);
    if (city) setSelectedCityId(city.id);
  };

  return (
    <div className="battlefield-shell" data-mobile-view={mobileView}>
      <header className="battle-topbar">
        <button className="battle-brand" onClick={onClose}><strong>问鼎</strong><span>{game.name}</span></button>
        <div className="stage-track" aria-label="对局阶段">
          <span className={currentStage === "MUSTER" ? "active" : ""}>蓄势 1—8</span><i></i><span className={currentStage === "CONTEST" ? "active" : ""}>争锋 9—18</span><i></i><span className={currentStage === "DECISIVE" ? "active" : ""}>决战 19+</span>
        </div>
        <div className="battle-controls">
          {extra}
          <span className="phase-indicator">第 {game.turn} 回合 · {phaseNames[game.phase]}</span>
        </div>
      </header>
      <nav className="mobile-battle-nav"><button className={mobileView === "map" ? "active" : ""} onClick={() => setMobileView("map")}>地图</button><button className={mobileView === "factions" ? "active" : ""} onClick={() => setMobileView("factions")}>势力</button><button className={mobileView === "events" ? "active" : ""} onClick={() => setMobileView("events")}>事件</button><button className={mobileView === "decision" ? "active" : ""} onClick={() => setMobileView("decision")}>决策</button></nav>

      <main className="battle-layout">
        <aside className="battle-panel faction-rail" data-mobile-section="factions">
          <div className="battle-panel-head"><h2>三方态势</h2><small>点击城市联动查看</small></div>
          <div className="faction-stack">{game.state.factions.map((faction) => {
            const runtime = game.config.factions.find((item) => item.factionId === faction.id);
            const cities = game.state.cities.filter((city) => city.ownerFactionId === faction.id);
            const troops = cities.reduce((sum, city) => sum + city.garrison, 0);
            const collapseThreshold = game.state.characters.some((character) => character.status === "active" && character.factionId === faction.id) ? 3 : 2;
            const modelName = runtime?.controller === "human" ? "人工控制" : runtime?.modelId ?? "";
            return <article className={`battle-faction owner-${faction.id} ${selectedFaction.id === faction.id ? "active" : ""} ${!faction.alive ? "fallen" : ""}`} key={faction.id}>
              <button className="faction-main" onClick={() => chooseFaction(faction.id)}><span className="faction-seal">{faction.name}</span><span className="faction-lord"><strong>{faction.leaderName}</strong><small>{faction.alive ? modelName : "势力已灭亡"}</small></span><i className="thinking-dot"></i></button>
              <div className="faction-metrics"><span>城池<b>{cities.length}</b></span><span>兵力<b>{troops}</b></span><span>金<b>{faction.gold}</b></span><span>粮<b>{faction.food}</b></span><span>声望<b>{faction.reputation ?? 60}</b></span></div>
              {(faction.collapseTurns ?? 0) > 0 && <div className="collapse-warning">首都失守 · 崩溃进度 {faction.collapseTurns}/{collapseThreshold}</div>}
              <div className="faction-city-links">{cities.map((city) => {
                const siege = game.state.sieges.find((item) => item.targetCityId === city.id);
                return <button className={selectedCity.id === city.id ? "selected" : ""} key={city.id} onClick={() => setSelectedCityId(city.id)}><b>{city.name}</b><small>{city.garrison}兵 · {city.id === faction.capitalCityId ? "首都" : siege ? "围城" : city.specialization ? specializationNames[city.specialization] : "稳定"}</small></button>;
              })}</div>
            </article>;
          })}</div>
          <div className="rail-intel"><span>当前关注</span><strong>{selectedFaction.name} · {selectedCity.name}</strong><p>{selectedSieges.length ? `遭受围城：${selectedSieges.map((siege) => `${factionNames[siege.attackerFactionId]} ${siege.progress}/3`).join("、")}` : `相邻 ${selectedCity.adjacentCityIds.map((id) => cityNames[id]).join("、")}`}</p></div>
        </aside>

        <div className="battle-center" data-mobile-section="map">
          <section className="battle-panel strategic-map-panel">
            <div className="map-heading"><div><h1>天下态势图</h1><p>按三国时期地理方位重排，路线以剧本连接关系为准</p></div><div className="map-legend" aria-label="地图图例"><span className="legend-attack"><i />进攻</span><span className="legend-transfer"><i />调兵</span><span className="legend-route"><i />路线</span></div></div>
            <div className="strategy-map">
              <svg className="route-layer" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><defs><marker id="attack-arrowhead" viewBox="0 0 6 6" markerWidth="6" markerHeight="6" refX="5.5" refY="3" orient="auto" markerUnits="strokeWidth"><path className="attack-arrowhead" d="M0 0 L6 3 L0 6 Z" /></marker>{["wei", "shu", "wu"].map((factionId) => <marker id={`transfer-arrowhead-${factionId}`} key={factionId} viewBox="0 0 6 6" markerWidth="6" markerHeight="6" refX="5.5" refY="3" orient="auto" markerUnits="strokeWidth"><path className={`transfer-arrowhead owner-${factionId}`} d="M0 0 L6 3 L0 6 Z" /></marker>)}</defs>{edges.map(([sourceId, targetId]) => {
                const source = cityPositions[sourceId]; const target = cityPositions[targetId];
                if (!source || !target) return null;
                return <line key={`${sourceId}-${targetId}`} x1={source.x} y1={source.y} x2={target.x} y2={target.y} />;
              })}{attackIndicators.map((attack) => {
                const source = cityPositions[attack.sourceCityId]; const target = cityPositions[attack.targetCityId];
                if (!source || !target) return null;
                const controlX = (source.x + target.x) / 2; const controlY = (source.y + target.y) / 2 - 5;
                return <path className="attack-arrow" key={`${attack.sourceCityId}-${attack.targetCityId}`} d={`M${source.x} ${source.y} Q${controlX} ${controlY} ${target.x} ${target.y}`} />;
              })}{transferIndicators.map((transfer, index) => {
                const source = cityPositions[transfer.sourceCityId]; const target = cityPositions[transfer.targetCityId];
                if (!source || !target) return null;
                const controlX = (source.x + target.x) / 2; const controlY = (source.y + target.y) / 2 + 4;
                return <path className={`transfer-arrow owner-${transfer.factionId}`} key={`${transfer.sourceCityId}-${transfer.targetCityId}-${index}`} d={`M${source.x} ${source.y} Q${controlX} ${controlY} ${target.x} ${target.y}`} />;
              })}</svg>
              <span className="region-label" style={{ left: "48%", top: "4%" }}>司隶</span><span className="region-label" style={{ left: "12%", top: "49%" }}>益州</span><span className="region-label" style={{ left: "49%", top: "47%" }}>荆州</span><span className="region-label" style={{ left: "75%", top: "42%" }}>扬州</span>
              {game.state.cities.map((city) => {
                const position = cityPositions[city.id] ?? { x: 50, y: 50 };
                const siege = game.state.sieges.find((item) => item.targetCityId === city.id);
                return <button className={`map-city owner-${city.ownerFactionId} ${selectedCity.id === city.id ? "selected" : ""} ${siege ? "besieged" : ""}`} style={{ left: `${position.x}%`, top: `${position.y}%` }} key={city.id} onClick={() => setSelectedCityId(city.id)}>
                  <strong>{city.name}<em></em></strong><span>{siege ? `围城 ${siege.progress}/3 · 告急` : `守军 ${city.garrison} · 城防 ${city.defenseLevel}`}</span>
                </button>;
              })}
              {(attackIndicators.length > 0 || transferIndicators.length > 0) && <div className="command-label-list">
                {attackIndicators.map((attack) => <div className="command-label attack-label" key={`attack-${attack.sourceCityId}-${attack.targetCityId}`}>进攻 · {cityNames[attack.sourceCityId]} → {cityNames[attack.targetCityId]} · {attack.troops} 兵</div>)}
                {transferIndicators.map((transfer, index) => <div className={`command-label transfer-label owner-${transfer.factionId}`} key={`transfer-${transfer.sourceCityId}-${transfer.targetCityId}-${index}`}>调兵 · {cityNames[transfer.sourceCityId]} → {cityNames[transfer.targetCityId]} · {transfer.troops} 兵</div>)}
              </div>}
            </div>
          </section>

          <section className="battle-panel city-command-panel" data-mobile-section="decision">
            <div className={`city-focus owner-${selectedCity.ownerFactionId}`}><span className="section-kicker">当前选择</span><h2>{selectedCity.name}</h2><div className={`ownership owner-${selectedCity.ownerFactionId}`}><i></i>{factionNames[selectedCity.ownerFactionId]}国控制{selectedCity.id === selectedFaction.capitalCityId ? " · 首都" : ""}</div><p>{selectedCity.occupationTurns > 0 ? `占领期剩余 ${selectedCity.occupationTurns} 回合` : selectedCity.unrestTurns > 0 ? `城市动荡 ${selectedCity.unrestTurns} 回合` : "城市秩序稳定"}</p><p>相邻：{selectedCity.adjacentCityIds.map((id) => cityNames[id]).join("、")}</p></div>
            <div className="city-operations"><div className="city-metrics"><span><small>守军</small><b>{selectedCity.garrison}</b></span><span><small>城防</small><b>{selectedCity.defenseLevel}</b></span><span><small>粮草产出</small><b>+{selectedCity.foodIncome}</b></span><span><small>金钱产出</small><b>+{selectedCity.goldIncome}</b></span><span><small>兵源</small><b>{selectedCity.manpower}/{selectedCity.manpowerCapacity}</b></span><span><small>专精</small><b>{selectedCity.specialization ? `${specializationNames[selectedCity.specialization]} ${selectedCity.specializationLevel}` : "未定"}</b></span></div><div className="section-label">合法行动（只读展示）</div><div className="city-action-list">{cityActions.length ? cityActions.map((action) => <div key={action.type}><strong>{actionName(action.type)}</strong><span>{actionDetail(action, selectedCity.id, cityNames)}</span></div>) : <p className="empty-copy">当前没有以此城为目标的主动行动。</p>}</div></div>
            <div className="decision-status"><div><h3>模型决策状态</h3><span className="order-pill status-submitted">{selectedRuntime?.controller === "human" ? "人工控制" : "模型已决策"}</span></div><p>{selectedFaction.alive ? `${selectedRuntime?.modelId ?? ""} 正在依据同一公开快照推演。` : "势力已灭亡。"}</p></div>
          </section>
        </div>

        <aside className="battle-panel log-rail" data-mobile-section="events">
          <div className="battle-panel-head"><h2>战局日志</h2><small>连续时间流</small></div>
          <div className="battle-events">{eventGroups.length ? eventGroups.map((group) => <section className="turn-event-group" key={group.turn}><div className="turn-event-label"><strong>第 {group.turn} 回合</strong><span>{group.turn === game.turn ? phaseNames[game.phase] : "已结算"}</span></div>{group.events.map((event) => <div className={`battle-event event-${eventCategory(event.type)}`} key={`${event.turn}-${event.id}`}><time>{eventCategoryName(event.type)}</time><p>{event.message}</p></div>)}</section>) : <p className="empty-copy">尚未产生公开事件。</p>}</div>
        </aside>
      </main>

      {game.phase === "FINISHED" && <section className="battle-panel battle-finale"><h2>天下归一</h2><p>{game.state.finishReason}</p>{game.state.audience.predictedWinnerFactionId && <p>观众预测：{factionNames[game.state.audience.predictedWinnerFactionId]} · {game.state.audience.predictionCorrect ? "命中" : "未命中"}</p>}</section>}
    </div>
  );
}

export function ReplayView({ gameId, onClose }: { gameId: string; onClose: () => void }) {
  const [replay, setReplay] = useState<ReplayGame>();
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const loaded = await fetchStatic<ReplayGame>(`replays/${gameId}.json`);
      setReplay(loaded);
      setIndex(loaded.turns.length - 1);
      setError("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    }
  }, [gameId]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!playing || !replay) return;
    const timer = setInterval(() => {
      setIndex((current) => {
        if (current >= replay.turns.length - 1) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, 1800);
    return () => clearInterval(timer);
  }, [playing, replay]);

  if (error) return <div className="battle-loading">{error}<br /><button onClick={() => void load()}>重试</button></div>;
  if (!replay) return <div className="battle-loading">加载回放中……</div>;

  const current = replay.turns[Math.max(0, Math.min(index, replay.turns.length - 1))]!;
  const events = replay.turns.slice(0, Math.max(0, Math.min(index, replay.turns.length - 1)) + 1).flatMap((turn) => turn.events);
  const atEnd = index >= replay.turns.length - 1;
  const controls = (
    <div className="replay-controls">
      <button className="battle-btn accent" onClick={() => setPlaying((value) => !value)}>{playing ? "暂停" : atEnd ? "重播" : "播放"}</button>
      <button className="battle-btn" onClick={() => setIndex((value) => Math.max(0, value - 1))}>上一回合</button>
      <span className="replay-turn-label">第 {current.turn} / {replay.turnCount} 回合</span>
      <input className="replay-slider" type="range" min={1} max={replay.turnCount} value={current.turn} onChange={(event) => { setPlaying(false); setIndex(Number(event.target.value) - 1); }} />
      <button className="battle-btn" onClick={() => setIndex((value) => Math.min(replay.turns.length - 1, value + 1))}>下一回合</button>
    </div>
  );

  return (
    <WatchBoard
      onClose={onClose}
      extra={controls}
      game={{ name: replay.name, phase: current.phase, turn: current.turn, state: current.state, config: replay.config, events }}
    />
  );
}

export function LiveView({ onClose }: { onClose: () => void }) {
  const [live, setLive] = useState<LiveSnapshot>();
  const [error, setError] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);

  const load = useCallback(async () => {
    try {
      setLive(await fetchStatic<LiveSnapshot>("replays/live.json", true));
      setError("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => void load(), 20000);
    return () => clearInterval(timer);
  }, [autoRefresh, load]);

  if (error) return <div className="battle-loading">{error}<br /><button onClick={() => void load()}>重试</button></div>;
  if (!live) return <div className="battle-loading">加载直播中……</div>;
  if (live.idle || !live.state || !live.config) return <div className="battle-loading">当前没有进行中的对局。<br /><button onClick={onClose}>返回首页</button></div>;

  const controls = (
    <div className="replay-controls live-controls">
      <span className="live-badge"><i />直播中</span>
      <span className="replay-turn-label">快照 {timeAgo(live.exportedAt)}</span>
      <button className="battle-btn" onClick={() => setAutoRefresh((value) => !value)}>{autoRefresh ? "暂停刷新" : "自动刷新"}</button>
      <button className="battle-btn" onClick={() => void load()}>立即刷新</button>
    </div>
  );

  return (
    <WatchBoard
      onClose={onClose}
      extra={controls}
      game={{ name: live.name ?? "", phase: live.phase ?? "WAITING_TO_ADVANCE", turn: live.turn ?? 0, state: live.state, config: live.config, events: live.events ?? [] }}
    />
  );
}
