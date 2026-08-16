import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { FactionController, GamePhase, GameRuntimeConfig, GameState, LegalAction, MainAction, ModelConfig, ModelDecision } from "@sanguo/shared";
import { LiveView, ReplayView, WatchHome } from "./watch";
import { FollowPrompt } from "./FollowPrompt";

interface GameSummary {
  id: string;
  name: string;
  phase: GamePhase;
  turn: number;
  winnerFactionId?: string;
  updatedAt: string;
}

interface PublicEvent {
  id: number;
  turn: number;
  type: string;
  factionId?: string;
  message: string;
  payload?: Record<string, unknown>;
}

interface OrderStatus {
  faction_id: string;
  controller: string;
  model_id?: string;
  status: string;
  error?: string;
  duration_ms?: number;
  attempts?: number;
}

interface GameDetail {
  id: string;
  name: string;
  phase: GamePhase;
  autoPlay: boolean;
  state: GameState;
  config: GameRuntimeConfig;
  events: PublicEvent[];
  orders: OrderStatus[];
  humanLegalActions: Record<string, LegalAction[]>;
  legalActions: Record<string, LegalAction[]>;
  memories: Array<{ faction_id: string; memory: string }>;
}

export const factionNames: Record<string, string> = { wei: "魏", shu: "蜀", wu: "吴" };
export const specializationNames = { commerce: "商贸", agriculture: "农桑", military: "军镇" } as const;
export const phaseNames: Record<GamePhase, string> = {
  DRAFT: "草稿",
  WAITING_TO_ADVANCE: "等待下一回合",
  PREPARING: "结算收入",
  COLLECTING_ORDERS: "各方决策中",
  ORDERS_LOCKED: "命令已锁定",
  RESOLVING: "结算行动",
  PUBLISHING: "发布结果",
  BLOCKED: "模型调用阻塞",
  FINISHED: "对局结束"
};

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...options,
    headers
  });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `请求失败：${response.status}`);
  return data;
}

type SiteMode = "loading" | "api" | "static";
interface Route { kind: "home" | "game" | "replay" | "live"; id?: string; }

function parseRoute(): Route {
  const hash = location.hash.replace(/^#/, "");
  const eq = hash.indexOf("=");
  const kind = eq >= 0 ? hash.slice(0, eq) : hash;
  const id = eq >= 0 ? hash.slice(eq + 1) : "";
  if (kind === "game" && id) return { kind: "game", id };
  if (kind === "replay" && id) return { kind: "replay", id };
  if (kind === "live") return { kind: "live" };
  return { kind: "home" };
}

export function App() {
  const [mode, setMode] = useState<SiteMode>("loading");
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [games, setGames] = useState<GameSummary[]>([]);
  const [route, setRoute] = useState<Route>(() => parseRoute());
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const response = await fetch("/api/health", { signal: controller.signal, cache: "no-store" });
        clearTimeout(timer);
        if (!cancelled) setMode(response.ok ? "api" : "static");
      } catch {
        if (!cancelled) setMode("static");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(parseRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const refreshHome = useCallback(async () => {
    try {
      const [modelList, gameList] = await Promise.all([api<ModelConfig[]>("/api/config/models"), api<GameSummary[]>("/api/games")]);
      setModels(modelList);
      setGames(gameList);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    }
  }, []);
  useEffect(() => { if (mode === "api") void refreshHome(); }, [mode, refreshHome]);

  const openGame = (id: string) => {
    localStorage.setItem("sanguo:lastGameId", id);
    location.hash = `game=${id}`;
  };
  const goHome = () => { location.hash = ""; };

  if (mode === "loading") return <main className="app-shell"><div className="battle-loading">正在检测运行模式……</div></main>;

  let view: ReactNode;
  if (route.kind === "game") {
    view = mode === "api"
      ? <GameView gameId={route.id!} models={models} onError={setError} onClose={goHome} />
      : <ReplayView gameId={route.id!} onClose={goHome} />;
  } else if (route.kind === "replay") {
    view = <ReplayView gameId={route.id!} onClose={goHome} />;
  } else if (route.kind === "live") {
    view = <LiveView onClose={goHome} />;
  } else if (mode === "api") {
    view = (
      <main className="app-shell">
        <header className="masthead">
          <div><h1>大模型血战三国</h1></div>
        </header>
        {error && <div className="error-banner" onClick={() => setError("")}>{error}</div>}
        <Home models={models} games={games} onCreated={openGame} onOpen={openGame} onError={setError} />
      </main>
    );
  } else {
    view = <WatchHome onOpenLive={() => { location.hash = "live"; }} onOpenReplay={(id) => { location.hash = `replay=${id}`; }} />;
  }
  return <>{view}<FollowPrompt /></>;
}

function Home({ models, games, onCreated, onOpen, onError }: { models: ModelConfig[]; games: GameSummary[]; onCreated: (id: string) => void; onOpen: (id: string) => void; onError: (message: string) => void }) {
  const preferredModels = ["deepseek-v4-flash", "doubao-seed-2.0-lite", "glm-latest"].map((modelId, index) => models.find((model) => model.id === modelId)?.id ?? models[index % Math.max(1, models.length)]?.id ?? "");
  const [name, setName] = useState("群雄逐鹿");
  const [controllers, setControllers] = useState<FactionController[]>(["model", "model", "model"]);
  const [selectedModels, setSelectedModels] = useState(["", "", ""]);
  const factions = ["wei", "shu", "wu"];
  const lastGameId = localStorage.getItem("sanguo:lastGameId");
  const lastGame = games.find((game) => game.id === lastGameId) ?? games.find((game) => game.phase !== "FINISHED");

  useEffect(() => {
    if (models.length && selectedModels.every((item) => !item)) setSelectedModels(preferredModels);
  }, [models, selectedModels]);

  const create = async () => {
    try {
      const game = await api<GameDetail>("/api/games", {
        method: "POST",
        body: JSON.stringify({
          name,
          factions: factions.map((factionId, index) => ({ factionId, controller: controllers[index], modelId: selectedModels[index] }))
        })
      });
      onCreated(game.id);
    } catch (requestError) {
      onError(requestError instanceof Error ? requestError.message : String(requestError));
    }
  };

  return (
    <div className="home-grid">
      <section className="panel create-panel">
        <h2>创建新对局</h2>
        <label>对局名称<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <div className="faction-setup">
          {factions.map((factionId, index) => (
            <div className={`faction-row faction-${factionId}`} key={factionId}>
              <strong>{factionNames[factionId]}</strong>
              <select value={controllers[index]} onChange={(event) => setControllers((items) => items.map((item, itemIndex) => itemIndex === index ? event.target.value as FactionController : item))}>
                <option value="model">模型控制</option>
                <option value="human">人工控制</option>
              </select>
              <select value={selectedModels[index]} onChange={(event) => setSelectedModels((items) => items.map((item, itemIndex) => itemIndex === index ? event.target.value : item))}>
                {models.map((model) => <option value={model.id} key={model.id}>{model.name}</option>)}
              </select>
            </div>
          ))}
        </div>
        <button className="primary" disabled={!models.length || !name.trim()} onClick={() => void create()}>创建对局</button>
      </section>
      <section className="panel history-panel">
        <h2>历史对局</h2>
        {lastGame && <button className="continue-game" onClick={() => onOpen(lastGame.id)}><span>继续上次对局</span><strong>{lastGame.name} · 第 {lastGame.turn} 回合</strong><small>{phaseNames[lastGame.phase]}，进度已保存在本机 SQLite</small></button>}
        {games.length === 0 && <p className="muted">还没有对局。</p>}
        {games.map((game) => (
          <button className="game-row" onClick={() => onOpen(game.id)} key={game.id}>
            <span><strong>{game.name}</strong><small>第 {game.turn} 回合 · {phaseNames[game.phase]}</small></span>
            <span>{game.winnerFactionId ? `${factionNames[game.winnerFactionId] ?? game.winnerFactionId}胜` : "继续"}</span>
          </button>
        ))}
      </section>
    </div>
  );
}

export const cityPositions: Record<string, { x: number; y: number }> = {
  luoyang: { x: 44, y: 15 }, xuchang: { x: 62, y: 22 }, wancheng: { x: 49, y: 40 },
  hanzhong: { x: 31, y: 45 }, chengdu: { x: 18, y: 72 }, jiangzhou: { x: 34, y: 76 },
  chaisang: { x: 59, y: 65 }, jianye: { x: 75, y: 57 }, wujun: { x: 84, y: 83 }
};

function GameView({ gameId, models, onError, onClose }: { gameId: string; models: ModelConfig[]; onError: (message: string) => void; onClose: () => void }) {
  const [game, setGame] = useState<GameDetail>();
  const [selectedCityId, setSelectedCityId] = useState("chengdu");
  const [mobileView, setMobileView] = useState<"map" | "factions" | "events" | "decision">("map");
  const load = useCallback(async () => {
    try { setGame(await api<GameDetail>(`/api/games/${gameId}`)); }
    catch (requestError) { onError(requestError instanceof Error ? requestError.message : String(requestError)); }
  }, [gameId, onError]);

  useEffect(() => {
    void load();
    const source = new EventSource(`/api/games/${gameId}/events`);
    const refresh = () => void load();
    ["phase", "game_event", "order_status", "turn_complete", "controller", "auto_play", "audience", "error"].forEach((type) => source.addEventListener(type, refresh));
    return () => source.close();
  }, [gameId, load]);

  const command = async (path: string, body?: unknown) => {
    try {
      await api(`/api/games/${gameId}${path}`, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
      await load();
    } catch (requestError) {
      onError(requestError instanceof Error ? requestError.message : String(requestError));
    }
  };

  if (!game) return <div className="battle-loading">读取对局中……</div>;
  const cityNames = Object.fromEntries(game.state.cities.map((city) => [city.id, city.name]));
  const selectedCity = game.state.cities.find((city) => city.id === selectedCityId) ?? game.state.cities[0]!;
  const selectedFaction = game.state.factions.find((faction) => faction.id === selectedCity.ownerFactionId)!;
  const selectedRuntime = game.config.factions.find((item) => item.factionId === selectedFaction.id)!;
  const selectedOrder = game.orders.find((item) => item.faction_id === selectedFaction.id);
  const selectedSieges = game.state.sieges.filter((siege) => siege.targetCityId === selectedCity.id);
  const currentStage = game.state.turn <= 8 ? "MUSTER" : game.state.turn <= 18 ? "CONTEST" : "DECISIVE";
  const edges = game.state.cities.flatMap((city) => city.adjacentCityIds.filter((targetId) => city.id < targetId).map((targetId) => [city.id, targetId] as const));
  const attackIndicators = [...new Map(game.events.filter((event) => event.turn === game.state.turn && (event.type === "attack_repulsed" || event.type === "city_captured") && typeof event.payload?.sourceCityId === "string" && typeof event.payload?.targetCityId === "string").map((event) => [`${event.payload!.sourceCityId}-${event.payload!.targetCityId}`, { sourceCityId: event.payload!.sourceCityId as string, targetCityId: event.payload!.targetCityId as string, troops: Number(event.payload!.troops ?? 0) }])).values()];
  const transferIndicators = game.events.filter((event) => event.turn === game.state.turn && event.type === "transfer" && typeof event.factionId === "string" && typeof event.payload?.sourceCityId === "string" && typeof event.payload?.targetCityId === "string").map((event) => ({ factionId: event.factionId!, sourceCityId: event.payload!.sourceCityId as string, targetCityId: event.payload!.targetCityId as string, troops: Number(event.payload!.troops ?? 0) }));
  const cityActions = (game.legalActions[selectedCity.ownerFactionId] ?? []).filter((action) => actionTouchesCity(action, selectedCity.id));
  const bookkeepingEvents = new Set(["turn_prepared", "resource_overflow", "administration_paid"]);
  const visibleEvents = [...game.events].reverse().filter((event) => !bookkeepingEvents.has(event.type)).slice(0, 60);
  const eventGroups = visibleEvents.reduce<Array<{ turn: number; events: PublicEvent[] }>>((groups, event) => {
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

  return <div className="battlefield-shell" data-mobile-view={mobileView}>
    <header className="battle-topbar">
      <button className="battle-brand" onClick={onClose}><strong>大模型血战三国</strong><span>{game.name}</span></button>
      <div className="stage-track" aria-label="对局阶段">
        <span className={currentStage === "MUSTER" ? "active" : ""}>蓄势 1—8</span><i></i><span className={currentStage === "CONTEST" ? "active" : ""}>争锋 9—18</span><i></i><span className={currentStage === "DECISIVE" ? "active" : ""}>决战 19+</span>
      </div>
      <div className="battle-controls">
        {game.phase === "WAITING_TO_ADVANCE" && <button className="battle-btn accent" onClick={() => void command("/advance")}>下一回合</button>}
        {game.phase !== "FINISHED" && <button className="battle-btn" onClick={() => void command(game.autoPlay ? "/pause" : "/auto-play", game.autoPlay ? undefined : { enabled: true })}>{game.autoPlay ? "暂停推演" : "继续推演"}</button>}
        {game.phase === "BLOCKED" && <button className="battle-btn danger" onClick={() => void command("/resume")}>恢复对局</button>}
        <span className="phase-indicator">第 {game.state.turn} 回合 · {phaseNames[game.phase]}</span>
      </div>
    </header>
    <nav className="mobile-battle-nav"><button className={mobileView === "map" ? "active" : ""} onClick={() => setMobileView("map")}>地图</button><button className={mobileView === "factions" ? "active" : ""} onClick={() => setMobileView("factions")}>势力</button><button className={mobileView === "events" ? "active" : ""} onClick={() => setMobileView("events")}>事件</button><button className={mobileView === "decision" ? "active" : ""} onClick={() => setMobileView("decision")}>决策</button></nav>

    <main className="battle-layout">
      <aside className="battle-panel faction-rail" data-mobile-section="factions">
        <div className="battle-panel-head"><h2>三方态势</h2><small>点击城市联动查看</small></div>
        <div className="faction-stack">{game.state.factions.map((faction) => {
          const runtime = game.config.factions.find((item) => item.factionId === faction.id)!;
          const order = game.orders.find((item) => item.faction_id === faction.id);
          const cities = game.state.cities.filter((city) => city.ownerFactionId === faction.id);
          const troops = cities.reduce((sum, city) => sum + city.garrison, 0);
          const collapseThreshold = game.state.characters.some((character) => character.status === "active" && character.factionId === faction.id) ? 3 : 2;
          const modelName = runtime.controller === "human" ? "人工控制" : models.find((model) => model.id === runtime.modelId)?.name ?? runtime.modelId;
          return <article className={`battle-faction owner-${faction.id} ${selectedFaction.id === faction.id ? "active" : ""} ${!faction.alive ? "fallen" : ""}`} key={faction.id}>
            <button className="faction-main" onClick={() => chooseFaction(faction.id)}><span className="faction-seal">{faction.name}</span><span className="faction-lord"><strong>{faction.leaderName}</strong><small>{faction.alive ? `${modelName} · ${orderStatus(order)}` : "势力已灭亡"}</small></span><i className={order?.status === "thinking" ? "thinking-dot live" : "thinking-dot"}></i></button>
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
          <div className="city-operations"><div className="city-metrics"><span><small>守军</small><b>{selectedCity.garrison}</b></span><span><small>城防</small><b>{selectedCity.defenseLevel}</b></span><span><small>粮草产出</small><b>+{selectedCity.foodIncome}</b></span><span><small>金钱产出</small><b>+{selectedCity.goldIncome}</b></span><span><small>兵源</small><b>{selectedCity.manpower}/{selectedCity.manpowerCapacity}</b></span><span><small>专精</small><b>{selectedCity.specialization ? `${specializationNames[selectedCity.specialization]} ${selectedCity.specializationLevel}` : "未定"}</b></span></div><div className="section-label">合法行动</div><div className="city-action-list">{cityActions.length ? cityActions.map((action) => <div key={action.type}><strong>{actionName(action.type)}</strong><span>{actionDetail(action, selectedCity.id, cityNames)}</span></div>) : <p className="empty-copy">当前没有以此城为目标的主动行动。</p>}</div></div>
          <div className="decision-status"><div><h3>模型决策状态</h3><span className={`order-pill status-${selectedOrder?.status ?? "pending"}`}>{orderStatus(selectedOrder)}</span></div><p>{selectedOrder?.error || `${selectedRuntime.controller === "human" ? "等待人工命令" : models.find((model) => model.id === selectedRuntime.modelId)?.name ?? selectedRuntime.modelId}正在依据同一公开快照推演。`}</p>{selectedFaction.alive && game.phase === "WAITING_TO_ADVANCE" && selectedRuntime.controller !== "human" && <button className="battle-btn full" onClick={() => void command(`/factions/${selectedFaction.id}/controller`, { controller: "human" })}>在回合间接管{selectedFaction.name}国</button>}{game.phase === "BLOCKED" && selectedOrder?.error && <div className="decision-buttons"><button onClick={() => void command(`/turns/${game.state.turn}/retry/${selectedFaction.id}`)}>重试</button><button onClick={() => void command(`/turns/${game.state.turn}/force-rest/${selectedFaction.id}`)}>强制休整</button></div>}</div>
        </section>
      </div>

      <aside className="battle-panel log-rail" data-mobile-section="events">
        <div className="battle-panel-head"><h2>战局日志</h2><small>连续时间流</small></div>
        <div className="battle-events">{eventGroups.length ? eventGroups.map((group) => <section className="turn-event-group" key={group.turn}><div className="turn-event-label"><strong>第 {group.turn} 回合</strong><span>{group.turn === game.state.turn ? `${phaseNames[game.phase]}` : "已结算"}</span></div>{group.events.map((event) => <div className={`battle-event event-${eventCategory(event.type)}`} key={event.id}><time>{eventCategoryName(event.type)}</time><p>{event.message}</p></div>)}</section>) : <p className="empty-copy">尚未产生公开事件。</p>}</div>
        {game.phase !== "FINISHED" && <SpectatorPanel game={game} onSubmit={(body) => command("/audience", body)} />}
      </aside>
    </main>

    {game.phase === "COLLECTING_ORDERS" && Object.entries(game.humanLegalActions).map(([factionId, actions]) => <HumanOrderForm key={factionId} factionId={factionId} actions={actions} state={game.state} cityNames={cityNames} onSubmit={(decision) => command("/orders", { factionId, decision })} />)}
    {game.phase === "FINISHED" && <section className="battle-panel battle-finale"><h2>天下归一</h2><p>{game.state.finishReason}</p>{game.state.audience.predictedWinnerFactionId && <p>观众预测：{factionNames[game.state.audience.predictedWinnerFactionId]} · {game.state.audience.predictionCorrect ? "命中" : "未命中"}</p>}</section>}
  </div>;
}

function orderStatus(order?: OrderStatus) {
  if (!order) return "等待命令";
  return ({ pending: "等待命令", thinking: "正在推演", submitted: "命令已锁定", error: "调用失败" } as Record<string, string>)[order.status] ?? order.status;
}

export function eventCategory(type: string) {
  if (/diplom|alliance|ceasefire|joint|gold_offered|troops_lent|city_ceded|sow_discord/.test(type)) return "diplomacy";
  if (/character/.test(type)) return "character";
  if (/decision|attack|recruit|transfer|fortify|develop|levy/.test(type)) return "action";
  return "resolution";
}

export function eventCategoryName(type: string) {
  return ({ diplomacy: "外交", character: "人物", action: "行动", resolution: "结算" } as const)[eventCategory(type)];
}

export function actionTouchesCity(action: LegalAction, cityId: string) {
  if (action.type === "rest") return false;
  if (action.type === "develop_city") return action.options.some((item) => item.cityId === cityId);
  if (action.type === "fortify") return action.cityIds.includes(cityId);
  if (action.type === "recruit" || action.type === "forced_levy") return action.cities.some((item) => item.cityId === cityId);
  if (action.type === "mobilize") return action.targets.some((target) => target.targetCityId === cityId);
  if (action.type === "grand_assault") return true;
  return action.routes.some((route) => route.sourceCityId === cityId || route.targetCityId === cityId);
}

export function actionDetail(action: LegalAction, cityId: string, cityNames: Record<string, string>) {
  if (action.type === "develop_city") return `${action.options.filter((item) => item.cityId === cityId).length} 条专精路线`;
  if (action.type === "fortify") return "提升永久城防";
  if (action.type === "recruit" || action.type === "forced_levy") return `最多 ${action.cities.find((item) => item.cityId === cityId)?.maxTroops ?? 0} 单位`;
  if (action.type === "mobilize") return `最多集结 ${action.targets.find((target) => target.targetCityId === cityId)?.maxTroops ?? 0} 单位`;
  if (action.type === "grand_assault") return `可总攻 ${action.targetFactionIds.map((id) => factionNames[id] ?? id).join("、")}`;
  if (action.type === "transfer" || action.type === "attack") {
    const routes = action.routes.filter((route) => route.sourceCityId === cityId || route.targetCityId === cityId);
    return routes.slice(0, 2).map((route) => `${cityNames[route.sourceCityId]}→${cityNames[route.targetCityId]}`).join("、");
  }
  return "本回合可执行";
}

function SpectatorPanel({ game, onSubmit }: { game: GameDetail; onSubmit: (body: unknown) => Promise<void> }) {
  const alive = game.state.factions.filter((faction) => faction.alive);
  const [targetFactionId, setTargetFactionId] = useState(alive[0]?.id ?? "");
  const [secondaryFactionId, setSecondaryFactionId] = useState(alive[1]?.id ?? "");
  const cooldown = Math.max(0, 4 - (game.state.turn - game.state.audience.lastInterventionTurn));
  return <div className="audience-console"><div className="section-label">观众密令 · 剩余 {game.state.audience.influence}</div><select value={targetFactionId} onChange={(event) => setTargetFactionId(event.target.value)}>{alive.map((faction) => <option value={faction.id} key={faction.id}>{faction.name}</option>)}</select><div className="audience-buttons"><button disabled={!targetFactionId || cooldown > 0 || game.state.audience.influence <= 0} onClick={() => void onSubmit({ type: "support", targetFactionId })}>资助</button><button disabled={!targetFactionId || !secondaryFactionId || targetFactionId === secondaryFactionId || cooldown > 0 || game.state.audience.influence <= 0} onClick={() => void onSubmit({ type: "rumor", targetFactionId, secondaryFactionId })}>流言</button>{game.state.turn <= 8 && <button onClick={() => void onSubmit({ type: "predict", targetFactionId })}>预测</button>}</div><select value={secondaryFactionId} onChange={(event) => setSecondaryFactionId(event.target.value)}>{alive.filter((faction) => faction.id !== targetFactionId).map((faction) => <option value={faction.id} key={faction.id}>{faction.name}</option>)}</select><small>{cooldown ? `冷却 ${cooldown} 回合` : "密令将在下一回合生效"}</small></div>;
}

function HumanOrderForm({ factionId, actions, state, cityNames, onSubmit }: { factionId: string; actions: LegalAction[]; state: GameState; cityNames: Record<string, string>; onSubmit: (decision: ModelDecision) => Promise<void> }) {
  const [type, setType] = useState<MainAction["type"]>("rest");
  const [cityId, setCityId] = useState("");
  const [routeIndex, setRouteIndex] = useState(0);
  const [troops, setTroops] = useState(1);
  const [publicMessage, setPublicMessage] = useState("");
  const [reasonSummary, setReasonSummary] = useState("人工玩家决策");
  const [diplomacyType, setDiplomacyType] = useState<"" | "message" | "propose_alliance" | "break_alliance">("");
  const [diplomacyTarget, setDiplomacyTarget] = useState(state.factions.find((item) => item.id !== factionId)?.id ?? "");
  const [diplomacyMessage, setDiplomacyMessage] = useState("");
  const [secretIntent] = useState<ModelDecision["secretIntent"]>("none");
  const selected = actions.find((action) => action.type === type) ?? actions[0]!;
  const pending = state.proposals.filter((proposal) => proposal.toFactionId === factionId && proposal.status === "pending");
  const [responses, setResponses] = useState<Record<string, "accept" | "reject">>({});

  const action = useMemo<MainAction>(() => {
    if (!selected || selected.type === "rest") return { type: "rest" };
    if (selected.type === "develop_city") {
      const option = selected.options[routeIndex] ?? selected.options[0]!;
      return { type: "develop_city", cityId: option.cityId, specialization: option.specialization };
    }
    if (selected.type === "fortify") return { type: "fortify", cityId: cityId || selected.cityIds[0]! };
    if (selected.type === "recruit" || selected.type === "forced_levy") {
      const city = selected.cities.find((item) => item.cityId === cityId) ?? selected.cities[0]!;
      return { type: selected.type, cityId: city.cityId, troops: Math.min(Math.max(1, troops), city.maxTroops) };
    }
    if (selected.type === "attack") {
      const route = selected.routes[routeIndex] ?? selected.routes[0]!;
      return { type: "attack", sourceCityId: route.sourceCityId, targetCityId: route.targetCityId, troops: Math.min(Math.max(route.minTroops, troops), route.maxTroops) };
    }
    if (selected.type === "transfer") {
      const route = selected.routes[routeIndex] ?? selected.routes[0]!;
      return { type: "transfer", sourceCityId: route.sourceCityId, targetCityId: route.targetCityId, troops: Math.min(Math.max(1, troops), route.maxTroops) };
    }
    if (selected.type === "mobilize") return { type: "mobilize", targetCityId: (selected.targets[routeIndex] ?? selected.targets[0]!).targetCityId };
    if (selected.type === "grand_assault") return { type: "grand_assault", targetFactionId: selected.targetFactionIds[routeIndex] ?? selected.targetFactionIds[0]! };
    return { type: "rest" };
  }, [selected, cityId, troops, routeIndex]);

  const submit = () => onSubmit({
    action,
    diplomacy: {
      responses: pending.filter((proposal) => responses[proposal.id]).map((proposal) => ({ proposalId: proposal.id, decision: responses[proposal.id]! })),
      initiative: diplomacyType ? { type: diplomacyType, targetFactionId: diplomacyTarget, message: diplomacyMessage || undefined } : undefined
    },
    secretIntent,
    publicMessage,
    reasonSummary,
    privateMemory: ""
  });

  return <section className="panel human-panel"><h2>{factionNames[factionId]} · 人工决策</h2><div className="form-grid"><label>主要行动<select value={type} onChange={(event) => { setType(event.target.value as MainAction["type"]); setCityId(""); setRouteIndex(0); }}><option value="rest">休整</option>{actions.filter((item) => item.type !== "rest").map((item) => <option key={item.type} value={item.type}>{actionName(item.type)}</option>)}</select></label>{selected?.type === "develop_city" && <label>城市专精<select value={routeIndex} onChange={(event) => setRouteIndex(Number(event.target.value))}>{selected.options.map((option, index) => <option value={index} key={`${option.cityId}-${option.specialization}`}>{cityNames[option.cityId]} → {specializationNames[option.specialization]} {option.nextLevel}级</option>)}</select></label>}{selected?.type === "fortify" && <label>城池<select value={cityId || selected.cityIds[0]} onChange={(event) => setCityId(event.target.value)}>{selected.cityIds.map((id) => <option value={id} key={id}>{cityNames[id]}</option>)}</select></label>}{(selected?.type === "recruit" || selected?.type === "forced_levy") && <><label>城池<select value={cityId || selected.cities[0]?.cityId} onChange={(event) => setCityId(event.target.value)}>{selected.cities.map((item) => <option value={item.cityId} key={item.cityId}>{cityNames[item.cityId]}（最多 {item.maxTroops}{"consequence" in item ? `，${item.consequence}` : ""}）</option>)}</select></label><label>兵力<input type="number" min="1" value={troops} onChange={(event) => setTroops(Number(event.target.value))} /></label></>}{selected && (selected.type === "transfer" || selected.type === "attack") && <><label>路线<select value={routeIndex} onChange={(event) => setRouteIndex(Number(event.target.value))}>{selected.routes.map((route, index) => <option value={index} key={`${route.sourceCityId}-${route.targetCityId}`}>{cityNames[route.sourceCityId]} → {cityNames[route.targetCityId]}（{"minTroops" in route ? `${route.minTroops}～` : "最多 "}{route.maxTroops}）</option>)}</select></label><label>兵力<input type="number" min={selected.type === "attack" ? selected.routes[routeIndex]?.minTroops ?? selected.routes[0]?.minTroops ?? 4 : 1} value={troops} onChange={(event) => setTroops(Number(event.target.value))} /></label></>}{selected?.type === "mobilize" && <label>集结目标<select value={routeIndex} onChange={(event) => setRouteIndex(Number(event.target.value))}>{selected.targets.map((target, index) => <option value={index} key={target.targetCityId}>{cityNames[target.targetCityId]}（最多 {target.maxTroops}）</option>)}</select></label>}{selected?.type === "grand_assault" && <label>总攻目标<select value={routeIndex} onChange={(event) => setRouteIndex(Number(event.target.value))}>{selected.targetFactionIds.map((id, index) => <option value={index} key={id}>{factionNames[id] ?? id}</option>)}</select></label>}</div>{pending.map((proposal) => <label key={proposal.id}>回应 {factionNames[proposal.fromFactionId]} 的结盟提议<select value={responses[proposal.id] ?? ""} onChange={(event) => setResponses((items) => ({ ...items, [proposal.id]: event.target.value as "accept" | "reject" }))}><option value="">暂不回应</option><option value="accept">接受</option><option value="reject">拒绝</option></select></label>)}<div className="form-grid"><label>外交<select value={diplomacyType} onChange={(event) => setDiplomacyType(event.target.value as typeof diplomacyType)}><option value="">无</option><option value="message">发送消息</option><option value="propose_alliance">提议结盟</option><option value="break_alliance">解除同盟</option></select></label>{diplomacyType && <label>目标<select value={diplomacyTarget} onChange={(event) => setDiplomacyTarget(event.target.value)}>{state.factions.filter((item) => item.id !== factionId && item.alive).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>}<label>公开发言<input value={publicMessage} maxLength={300} onChange={(event) => setPublicMessage(event.target.value)} /></label><label>理由摘要<input value={reasonSummary} maxLength={500} onChange={(event) => setReasonSummary(event.target.value)} /></label></div>{diplomacyType === "message" && <label>外交消息<textarea value={diplomacyMessage} maxLength={300} onChange={(event) => setDiplomacyMessage(event.target.value)} /></label>}<button className="primary" onClick={() => void submit()}>提交并锁定命令</button></section>;
}

export function actionName(type: LegalAction["type"]) {
  return ({ rest: "休整", develop_city: "建设专精", recruit: "征兵", forced_levy: "强征", fortify: "修筑城防", transfer: "调兵", attack: "出征", mobilize: "战略集结", grand_assault: "天下总攻" } as Record<string, string>)[type] ?? type;
}
