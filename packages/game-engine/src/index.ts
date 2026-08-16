import {
  modelDecisionSchema,
  type CityState,
  type CitySpecialization,
  type BorderThreat,
  type CharacterState,
  type DiplomaticRelation,
  type DiplomacyInitiative,
  type GameEvent,
  type GameState,
  type GameStage,
  type LegalAction,
  type MainAction,
  type ModelDecision,
  type Observation,
  type PrepareTurnResult,
  type ResolveTurnResult,
  type VictoryResult
} from "@sanguo/shared";

export interface ScenarioDefinition {
  id: string;
  maxTurns: number;
  factions: GameState["factions"];
  cities: GameState["cities"];
  characters?: CharacterState[];
}

const restDecision = (reason = "本回合休整"): ModelDecision => ({
  action: { type: "rest" },
  diplomacy: { responses: [] },
  secretIntent: "none",
  publicMessage: "",
  reasonSummary: reason,
  privateMemory: ""
});

const clone = <T>(value: T): T => structuredClone(value);
const developmentCost = 12;
const forcedLevyGoldCost = 8;
const forcedLevyFoodCost = 6;
const mobilizeGoldCost = 8;
const mobilizeFoodCost = 6;
const grandAssaultGoldCost = 30;
const grandAssaultFoodCost = 40;

export function getGameStage(turn: number): GameStage {
  if (turn <= 8) return "MUSTER";
  if (turn <= 18) return "CONTEST";
  return "DECISIVE";
}

function isDecisiveWar(state: GameState) {
  return state.factions.filter((faction) => faction.alive).length === 2;
}

function captureAdvantage(state: GameState) {
  if (isDecisiveWar(state)) return 1.05;
  const stage = getGameStage(state.turn);
  if (stage === "MUSTER") return 1.2;
  if (stage === "CONTEST") return 1.15;
  return 1.1;
}

function inferSpecialization(city: CityState): { specialization: CitySpecialization | null; level: number } {
  if (city.specialization !== undefined && city.specializationLevel !== undefined) {
    return { specialization: city.specialization, level: city.specializationLevel };
  }
  const commerce = city.commerceLevel ?? 0;
  const agriculture = city.agricultureLevel ?? 0;
  if (commerce === 0 && agriculture === 0) return { specialization: null, level: 0 };
  return commerce >= agriculture
    ? { specialization: "commerce", level: Math.min(2, commerce) }
    : { specialization: "agriculture", level: Math.min(2, agriculture) };
}

export function normalizeGameState(input: GameState): GameState {
  const state = clone(input);
  if (state.scenarioId === "basic" && state.rulesetVersion !== "2.3.0") {
    const jiangzhou = state.cities.find((city) => city.id === "jiangzhou");
    const chaisang = state.cities.find((city) => city.id === "chaisang");
    const jianye = state.cities.find((city) => city.id === "jianye");
    if (jiangzhou && chaisang && jianye) {
      jiangzhou.adjacentCityIds = [...new Set(jiangzhou.adjacentCityIds.filter((id) => id !== "jianye").concat("chaisang"))];
      chaisang.adjacentCityIds = [...new Set(chaisang.adjacentCityIds.concat("jiangzhou"))];
      jianye.adjacentCityIds = jianye.adjacentCityIds.filter((id) => id !== "jiangzhou");
    }
  }
  state.rulesetVersion = "2.3.0";
  state.sieges ??= [];
  state.jointOperations ??= [];
  state.characters ??= [];
  state.director ??= { lastCaptureTurn: 0, lastEventTurn: 0 };
  state.director.lastStandCounts ??= {};
  state.audience ??= { influence: 3, lastInterventionTurn: -4, orders: [] };
  state.worldWearinessApplied ??= false;
  state.factions = state.factions.map((faction) => ({ ...faction, reputation: faction.reputation ?? 60, collapseTurns: faction.collapseTurns ?? 0 }));
  state.relations = (state.relations ?? []).map((relation) => ({ ...relation, trust: relation.trust ?? 50 }));
  state.cities = state.cities.map((city) => {
    const inferred = inferSpecialization(city);
    return {
      ...city,
      specialization: inferred.specialization,
      specializationLevel: inferred.level,
      unrestTurns: city.unrestTurns ?? 0
    };
  });
  return state;
}

const pairKey = (a: string, b: string) => [a, b].sort().join(":");

function findRelation(state: GameState, a: string, b: string) {
  const key = pairKey(a, b);
  return state.relations.find((item) => pairKey(item.factionAId, item.factionBId) === key);
}

function getRelation(state: GameState, a: string, b: string): DiplomaticRelation {
  let relation = findRelation(state, a, b);
  if (!relation) {
    relation = { factionAId: [a, b].sort()[0]!, factionBId: [a, b].sort()[1]!, status: "neutral", trust: 50 };
    state.relations.push(relation);
  }
  return relation;
}

function areAllied(state: GameState, a: string, b: string) {
  return findRelation(state, a, b)?.status === "alliance";
}

function areInCeasefire(state: GameState, a: string, b: string) {
  const until = findRelation(state, a, b)?.ceasefireUntilTurn;
  return until !== undefined && until >= state.turn;
}

function cityById(state: GameState, cityId: string) {
  return state.cities.find((city) => city.id === cityId);
}

function factionById(state: GameState, factionId: string) {
  return state.factions.find((faction) => faction.id === factionId);
}

function connectedOwnedCities(state: GameState, factionId: string, targetCityId: string) {
  const visited = new Set([targetCityId]);
  const queue = [targetCityId];
  while (queue.length) {
    const city = cityById(state, queue.shift()!);
    for (const adjacentId of city?.adjacentCityIds ?? []) {
      if (visited.has(adjacentId) || cityById(state, adjacentId)?.ownerFactionId !== factionId) continue;
      visited.add(adjacentId);
      queue.push(adjacentId);
    }
  }
  return state.cities.filter((city) => visited.has(city.id));
}

export function createInitialState(scenario: ScenarioDefinition): GameState {
  return normalizeGameState({
    rulesetVersion: "2.3.0",
    scenarioId: scenario.id,
    turn: 0,
    maxTurns: scenario.maxTurns,
    factions: clone(scenario.factions).map((faction) => ({ ...faction, alive: true, reputation: faction.reputation ?? 60 })),
    cities: clone(scenario.cities),
    relations: [],
    proposals: [],
    jointOperations: [],
    characters: clone(scenario.characters ?? []),
    director: { lastCaptureTurn: 0, lastEventTurn: 0, lastStandCounts: {} },
    audience: { influence: 3, lastInterventionTurn: -4, orders: [] },
    domination: { consecutiveTurns: 0 },
    sieges: [],
    worldWearinessApplied: false
  });
}

export function getTurnPriority(state: GameState): string[] {
  const alive = state.factions.filter((faction) => faction.alive).map((faction) => faction.id);
  if (alive.length === 0) return [];
  const offset = Math.max(0, state.turn - 1) % alive.length;
  return [...alive.slice(offset), ...alive.slice(0, offset)];
}

function applyScheduledDiplomacy(state: GameState, events: GameEvent[]) {
  for (const relation of state.relations) {
    if (relation.scheduledTurn !== undefined && relation.scheduledTurn <= state.turn && relation.scheduledStatus) {
      relation.status = relation.scheduledStatus;
      events.push({
        type: "diplomacy_changed",
        turn: state.turn,
        message: `${relation.factionAId} 与 ${relation.factionBId} 的关系变为${relation.status === "alliance" ? "同盟" : "中立"}`
      });
      delete relation.scheduledStatus;
      delete relation.scheduledTurn;
    }
    if (relation.status === "alliance" && relation.allianceUntilTurn !== undefined && state.turn > relation.allianceUntilTurn) {
      relation.status = "neutral";
      delete relation.allianceUntilTurn;
      events.push({
        type: "alliance_expired",
        turn: state.turn,
        message: `${relation.factionAId} 与 ${relation.factionBId} 的同盟到期`
      });
    }
    if (relation.ceasefireUntilTurn !== undefined && state.turn > relation.ceasefireUntilTurn) {
      delete relation.ceasefireUntilTurn;
      events.push({ type: "ceasefire_expired", turn: state.turn, message: `${relation.factionAId} 与 ${relation.factionBId} 的停战到期` });
    }
  }
  state.jointOperations = state.jointOperations.filter((operation) => operation.untilTurn >= state.turn);
}

function clamp(value: number, minimum = 0, maximum = 100) {
  return Math.max(minimum, Math.min(maximum, value));
}

function applyAudienceOrders(state: GameState, events: GameEvent[]) {
  for (const order of state.audience.orders.filter((item) => !item.resolved && item.submittedTurn < state.turn)) {
    order.resolved = true;
    const target = factionById(state, order.targetFactionId);
    if (!target?.alive) continue;
    if (order.type === "support") {
      target.gold += 10;
      target.food += 10;
      events.push({ type: "audience_support", turn: state.turn, factionId: target.id, message: `一封匿名密令为${target.id}送来 10 金与 10 粮` });
    } else if (order.secondaryFactionId && factionById(state, order.secondaryFactionId)?.alive) {
      const relation = getRelation(state, target.id, order.secondaryFactionId);
      relation.trust = clamp((relation.trust ?? 50) - 20);
      events.push({ type: "audience_rumor", turn: state.turn, message: `匿名流言动摇了${target.id}与${order.secondaryFactionId}的互信` });
      if (relation.status === "alliance" && relation.trust <= 20) {
        relation.status = "neutral";
        delete relation.allianceUntilTurn;
        events.push({ type: "alliance_broken_by_rumor", turn: state.turn, message: `${target.id} 与 ${order.secondaryFactionId} 因猜忌解除同盟` });
      }
    }
  }
}

function applyDirector(state: GameState, events: GameEvent[]) {
  if (state.turn - state.director.lastEventTurn < 4) return;
  const alive = state.factions.filter((faction) => faction.alive);
  if (alive.length < 2) return;
  const cityCount = (factionId: string) => state.cities.filter((city) => city.ownerFactionId === factionId).length;
  const troopCount = (factionId: string) => state.cities.filter((city) => city.ownerFactionId === factionId).reduce((sum, city) => sum + city.garrison, 0);
  const ranked = [...alive].sort((a, b) => cityCount(b.id) - cityCount(a.id) || troopCount(b.id) - troopCount(a.id));
  const leader = ranked[0]!;
  const weakest = ranked[ranked.length - 1]!;

  if (isDecisiveWar(state) && cityCount(leader.id) - cityCount(weakest.id) >= 3) {
    const lastStandCount = state.director.lastStandCounts?.[weakest.id] ?? 0;
    if (lastStandCount >= 2) return;
    const capital = cityById(state, weakest.capitalCityId) ?? state.cities.find((city) => city.ownerFactionId === weakest.id);
    if (capital) {
      capital.garrison += 4;
      capital.unrestTurns = Math.max(capital.unrestTurns, 1);
      state.director.lastStandCounts![weakest.id] = lastStandCount + 1;
      state.director.lastEventTurn = state.turn;
      events.push({ type: "director_last_stand", turn: state.turn, factionId: weakest.id, message: `${weakest.id}触发背水一战（${lastStandCount + 1}/2），${capital.name}集结 4 兵，但民心动荡` });
      return;
    }
  }

  if (isDecisiveWar(state)) return;

  if (cityCount(leader.id) - cityCount(weakest.id) >= 3) {
    leader.reputation = clamp((leader.reputation ?? 60) - 8);
    const rivals = alive.filter((item) => item.id !== leader.id);
    if (rivals.length === 2) {
      const relation = getRelation(state, rivals[0]!.id, rivals[1]!.id);
      relation.trust = clamp((relation.trust ?? 50) + 20);
      const exists = state.jointOperations.some((operation) => operation.factionAId === rivals[0]!.id && operation.factionBId === rivals[1]!.id && operation.enemyFactionId === leader.id);
      if (!exists) state.jointOperations.push({ factionAId: rivals[0]!.id, factionBId: rivals[1]!.id, enemyFactionId: leader.id, untilTurn: state.turn + 2 });
    }
    state.director.lastEventTurn = state.turn;
    events.push({ type: "director_coalition", turn: state.turn, factionId: leader.id, message: `${leader.id}势大，引发天下共讨，声望下降` });
    return;
  }

  if (state.turn >= 10 && state.turn - state.director.lastCaptureTurn >= 5) {
    for (const city of state.cities.filter((item) => item.ownerFactionId === weakest.id)) city.manpower = Math.min(city.manpowerCapacity, city.manpower + 2);
    const capital = cityById(state, weakest.capitalCityId) ?? state.cities.find((city) => city.ownerFactionId === weakest.id);
    if (capital) capital.garrison += 2;
    state.director.lastEventTurn = state.turn;
    events.push({ type: "director_stalemate", turn: state.turn, factionId: weakest.id, message: `战局久滞，流民投奔${weakest.id}，补充兵源并集结 2 兵` });
  }
}

function removeDeserters(state: GameState, factionId: string, count: number, events: GameEvent[]) {
  let remaining = count;
  while (remaining > 0) {
    const cities = state.cities
      .filter((city) => city.ownerFactionId === factionId && city.garrison > 0)
      .sort((a, b) => b.garrison - a.garrison || a.id.localeCompare(b.id));
    const city = cities[0];
    if (!city) break;
    city.garrison -= 1;
    remaining -= 1;
  }
  if (count > 0) {
    events.push({ type: "desertion", turn: state.turn, factionId, message: `${factionId} 因粮草不足损失 ${count - remaining} 兵力` });
  }
}

function cityIncomeMultiplier(city: CityState) {
  return city.occupationTurns > 0 || city.unrestTurns > 0 ? 0.5 : 1;
}

function upkeepDivisor(turn: number) {
  const stage = getGameStage(turn);
  if (stage === "MUSTER") return 4;
  if (stage === "CONTEST") return 3;
  return 2;
}

export function getFactionResourceCaps(state: GameState, factionId: string) {
  const cities = state.cities.filter((city) => city.ownerFactionId === factionId);
  const commerceLevelTwo = cities.filter((city) => city.specialization === "commerce" && city.specializationLevel >= 2).length;
  const agricultureLevelTwo = cities.filter((city) => city.specialization === "agriculture" && city.specializationLevel >= 2).length;
  return {
    gold: 80 + cities.length * 20 + commerceLevelTwo * 20,
    food: 120 + cities.length * 30 + agricultureLevelTwo * 30
  };
}

function decaySieges(state: GameState, events: GameEvent[]) {
  for (const siege of state.sieges) {
    if (state.turn - siege.lastPressureTurn < 3) continue;
    siege.progress -= 1;
    siege.lastPressureTurn = state.turn;
    const city = cityById(state, siege.targetCityId);
    events.push({ type: "siege_decayed", turn: state.turn, factionId: siege.attackerFactionId, message: `${siege.attackerFactionId} 对${city?.name ?? siege.targetCityId}的围城进度衰减` });
  }
  state.sieges = state.sieges.filter((siege) => siege.progress > 0);
}

function applyDecisiveDiplomacy(state: GameState, events: GameEvent[]) {
  if (!isDecisiveWar(state)) return;
  for (const relation of state.relations.filter((item) => item.status === "alliance" || item.scheduledStatus === "alliance")) {
    relation.status = "neutral";
    delete relation.allianceUntilTurn;
    delete relation.scheduledStatus;
    delete relation.scheduledTurn;
    events.push({ type: "decisive_alliance_ended", turn: state.turn, message: `${relation.factionAId} 与 ${relation.factionBId} 的同盟因进入两强决战而终止` });
  }
  for (const proposal of state.proposals.filter((item) => item.status === "pending")) proposal.status = "expired";
}

export function prepareTurn(input: GameState): PrepareTurnResult {
  const state = normalizeGameState(input);
  state.turn += 1;
  const events: GameEvent[] = [];
  applyScheduledDiplomacy(state, events);
  applyDecisiveDiplomacy(state, events);
  decaySieges(state, events);
  applyAudienceOrders(state, events);
  applyDirector(state, events);
  for (const character of state.characters.filter((item) => item.status === "captive")) character.loyalty = clamp(character.loyalty - 5);

  if (state.turn >= 31 && !state.worldWearinessApplied) {
    for (const city of state.cities) city.defenseLevel = Math.max(0, city.defenseLevel - 1);
    state.worldWearinessApplied = true;
    events.push({ type: "world_weariness", turn: state.turn, message: "天下疲敝，所有城池永久城防降低 1 级" });
  }

  for (const proposal of state.proposals) {
    if (proposal.status === "pending" && proposal.createdTurn < state.turn - 1) proposal.status = "expired";
  }

  const stage = getGameStage(state.turn);
  for (const city of state.cities) {
    const manpowerRecovery = stage === "MUSTER" ? city.manpowerRecovery : stage === "CONTEST" ? Math.min(1, city.manpowerRecovery) : 0;
    city.manpower = Math.min(city.manpowerCapacity, city.manpower + manpowerRecovery);
    const owner = factionById(state, city.ownerFactionId);
    if (!owner) continue;
    const multiplier = cityIncomeMultiplier(city);
    owner.gold += Math.floor(city.goldIncome * multiplier);
    owner.food += Math.floor(city.foodIncome * multiplier);
  }

  for (const faction of state.factions.filter((item) => item.alive)) {
    const owned = state.cities.filter((city) => city.ownerFactionId === faction.id);
    const troops = owned.reduce((sum, city) => sum + city.garrison, 0);
    const extraCities = Math.max(0, owned.length - 3);
    const occupiedCities = owned.filter((city) => city.occupationTurns > 0).length;
    const administrationGold = extraCities * 3 + occupiedCities * 2;
    const administrationFood = extraCities * 4 + occupiedCities * 2;
    const upkeep = Math.ceil(troops / upkeepDivisor(state.turn));
    faction.gold = Math.max(0, faction.gold - administrationGold);
    const foodCost = upkeep + administrationFood;
    if (faction.food >= foodCost) {
      faction.food -= foodCost;
    } else {
      const shortage = foodCost - faction.food;
      faction.food = 0;
      removeDeserters(state, faction.id, shortage, events);
    }
    if (administrationGold || administrationFood) {
      events.push({ type: "administration_paid", turn: state.turn, factionId: faction.id, message: `${faction.id} 支付行政成本 ${administrationGold} 金、${administrationFood} 粮` });
    }

    const caps = getFactionResourceCaps(state, faction.id);
    const goldOverflow = Math.max(0, faction.gold - caps.gold);
    const foodOverflow = Math.max(0, faction.food - caps.food);
    faction.gold = Math.min(faction.gold, caps.gold);
    faction.food = Math.min(faction.food, caps.food);
    if (goldOverflow || foodOverflow) {
      events.push({ type: "resource_overflow", turn: state.turn, factionId: faction.id, message: `${faction.id} 库存溢出，损失 ${goldOverflow} 金、${foodOverflow} 粮` });
    }
  }

  events.push({ type: "turn_prepared", turn: state.turn, message: `第 ${state.turn} 回合（${stage === "MUSTER" ? "蓄势" : stage === "CONTEST" ? "争锋" : "决战"}阶段）收入与维持已结算` });
  return { state, events, priority: getTurnPriority(state) };
}

export function listLegalActions(state: GameState, factionId: string): LegalAction[] {
  const faction = factionById(state, factionId);
  if (!faction?.alive) return [{ type: "rest" }];
  const owned = state.cities.filter((city) => city.ownerFactionId === factionId);
  const result: LegalAction[] = [{ type: "rest" }];
  const stage = getGameStage(state.turn);

  if (stage !== "DECISIVE" && faction.gold >= developmentCost) {
    const options = owned.flatMap((city) => {
      if (city.occupationTurns > 0 || city.unrestTurns > 0 || city.specializationLevel >= 2) return [];
      const specializations: CitySpecialization[] = city.specialization ? [city.specialization] : ["commerce", "agriculture", "military"];
      return specializations.map((specialization) => ({ cityId: city.id, specialization, nextLevel: city.specializationLevel + 1 }));
    });
    if (options.length) result.push({ type: "develop_city", options });
  }

  const recruitCities = owned.map((city) => ({
    cityId: city.id,
    maxTroops: city.occupationTurns > 0 || city.unrestTurns > 0
      ? 0
      : Math.min(5 + (city.specialization === "military" ? city.specializationLevel : 0), city.manpower, Math.floor(faction.gold / 2), faction.food)
  })).filter((item) => item.maxTroops > 0);
  if (recruitCities.length) result.push({ type: "recruit", cities: recruitCities });

  if (stage === "DECISIVE") {
    const totalTroops = owned.reduce((sum, city) => sum + city.garrison, 0);
    const levyCities = totalTroops <= owned.length * 3 ? owned.map((city) => ({
      cityId: city.id,
      maxTroops: city.occupationTurns > 0 || city.unrestTurns > 0 || (city.lastForcedLevyTurn !== undefined && state.turn - city.lastForcedLevyTurn < 3)
        ? 0
        : Math.min(3, Math.floor(faction.gold / forcedLevyGoldCost), Math.floor(faction.food / forcedLevyFoodCost)),
      consequence: `每兵 8 金、6 粮；${city.specializationLevel > 0 ? "城市专精降低 1 级" : "城市动荡 2 回合"}`
    })).filter((item) => item.maxTroops > 0) : [];
    if (levyCities.length) result.push({ type: "forced_levy", cities: levyCities });
  }

  const fortifyCities = owned.filter((city) => {
    const defenseCap = city.specialization === "military" && city.specializationLevel >= 2 ? 4 : 3;
    return state.turn < 25 && city.occupationTurns === 0 && city.unrestTurns === 0 && city.defenseLevel < defenseCap;
  }).map((city) => city.id);
  if (faction.gold >= 6 && faction.food >= 4 && fortifyCities.length) result.push({ type: "fortify", cityIds: fortifyCities });

  const transferRoutes: Array<{ sourceCityId: string; targetCityId: string; maxTroops: number }> = [];
  const attackRoutes: Array<{ sourceCityId: string; targetCityId: string; minTroops: number; maxTroops: number; requiresBetrayal?: "alliance" | "ceasefire" }> = [];
  for (const source of owned.filter((city) => city.garrison > 1)) {
    for (const targetId of source.adjacentCityIds) {
      const target = cityById(state, targetId);
      if (!target) continue;
      if (target.ownerFactionId === factionId) {
        transferRoutes.push({ sourceCityId: source.id, targetCityId: target.id, maxTroops: source.garrison - 1 });
      } else if (source.occupationTurns === 0) {
        const maxTroops = Math.min(source.garrison - 1, faction.food);
        const minTroops = Math.max(4, Math.ceil(maxTroops * 0.6));
        const requiresBetrayal = areAllied(state, factionId, target.ownerFactionId) ? "alliance" : areInCeasefire(state, factionId, target.ownerFactionId) ? "ceasefire" : undefined;
        if (maxTroops >= minTroops) attackRoutes.push({ sourceCityId: source.id, targetCityId: target.id, minTroops, maxTroops, requiresBetrayal });
      }
    }
  }
  if (transferRoutes.length) result.push({ type: "transfer", routes: transferRoutes });
  if (attackRoutes.length) result.push({ type: "attack", routes: attackRoutes });
  if (stage !== "MUSTER" && faction.gold >= mobilizeGoldCost && faction.food >= mobilizeFoodCost) {
    const targets = owned.flatMap((target) => {
      const isBorder = target.adjacentCityIds.some((id) => cityById(state, id)?.ownerFactionId !== factionId);
      if (!isBorder || target.occupationTurns > 0) return [];
      const sources = connectedOwnedCities(state, factionId, target.id).filter((city) => city.id !== target.id && city.garrison > 1);
      const maxTroops = Math.min(8, sources.reduce((sum, city) => sum + city.garrison - 1, 0));
      return maxTroops >= 3 ? [{ targetCityId: target.id, sourceCityIds: sources.map((city) => city.id), maxTroops }] : [];
    });
    if (targets.length) result.push({ type: "mobilize", targets });
  }
  if (owned.length >= 7 && faction.gold >= grandAssaultGoldCost && faction.food >= grandAssaultFoodCost) {
    const targetFactionIds = state.factions.filter((target) => target.alive && target.id !== factionId && owned.some((source) => source.garrison >= 5 && source.adjacentCityIds.some((id) => cityById(state, id)?.ownerFactionId === target.id))).map((target) => target.id);
    if (targetFactionIds.length) result.push({ type: "grand_assault", targetFactionIds });
  }
  return result;
}

export function validateAction(state: GameState, factionId: string, action: MainAction): string | undefined {
  const faction = factionById(state, factionId);
  if (!faction?.alive) return "势力已经灭亡";
  if (action.type === "rest") return undefined;

  if (action.type === "develop_city" || action.type === "develop_commerce" || action.type === "develop_agriculture") {
    const city = cityById(state, action.cityId);
    if (!city || city.ownerFactionId !== factionId) return "目标不是己方城池";
    if (city.occupationTurns > 0) return "新占领城池不能发展";
    if (city.unrestTurns > 0) return "动荡城池不能发展";
    if (getGameStage(state.turn) === "DECISIVE") return "决战阶段不能继续发展城市";
    const specialization = action.type === "develop_city" ? action.specialization : action.type === "develop_commerce" ? "commerce" : "agriculture";
    if (city.specialization && city.specialization !== specialization) return "城市已经选择其他专精";
    if (city.specializationLevel >= 2) return "城市专精已达上限";
    if (faction.gold < developmentCost) return "金钱不足";
    return undefined;
  }

  if (action.type === "recruit") {
    const city = cityById(state, action.cityId);
    if (!city || city.ownerFactionId !== factionId) return "目标不是己方城池";
    if (city.occupationTurns > 0 || city.unrestTurns > 0) return "占领或动荡城池不能征兵";
    const recruitCap = 5 + (city.specialization === "military" ? city.specializationLevel : 0);
    if (action.troops > recruitCap) return "单次征兵超过上限";
    if (city.manpower < action.troops) return "兵源不足";
    if (faction.gold < action.troops * 2) return "金钱不足";
    if (faction.food < action.troops) return "粮草不足";
    return undefined;
  }

  if (action.type === "forced_levy") {
    const city = cityById(state, action.cityId);
    if (!city || city.ownerFactionId !== factionId) return "目标不是己方城池";
    if (getGameStage(state.turn) !== "DECISIVE") return "只有决战阶段可以强征";
    const owned = state.cities.filter((item) => item.ownerFactionId === factionId);
    if (owned.reduce((sum, item) => sum + item.garrison, 0) > owned.length * 3) return "当前总兵力尚未达到强征条件";
    if (city.occupationTurns > 0 || city.unrestTurns > 0) return "占领或动荡城池不能强征";
    if (city.lastForcedLevyTurn !== undefined && state.turn - city.lastForcedLevyTurn < 3) return "该城强征仍在冷却";
    if (faction.gold < action.troops * forcedLevyGoldCost || faction.food < action.troops * forcedLevyFoodCost) return "强征资源不足";
    return undefined;
  }

  if (action.type === "fortify") {
    const city = cityById(state, action.cityId);
    if (!city || city.ownerFactionId !== factionId) return "目标不是己方城池";
    if (city.occupationTurns > 0) return "新占领城池不能修筑城防";
    if (city.unrestTurns > 0) return "动荡城池不能修筑城防";
    if (state.turn >= 25) return "第 25 回合起不能继续修筑城防";
    const defenseCap = city.specialization === "military" && city.specializationLevel >= 2 ? 4 : 3;
    if (city.defenseLevel >= defenseCap) return "城防已达上限";
    if (faction.gold < 6 || faction.food < 4) return "资源不足";
    return undefined;
  }

  if (action.type === "mobilize") {
    const target = cityById(state, action.targetCityId);
    if (!target || target.ownerFactionId !== factionId) return "集结目标不是己方城池";
    if (getGameStage(state.turn) === "MUSTER") return "蓄势阶段不能战略集结";
    if (target.occupationTurns > 0) return "新占领城池不能作为集结目标";
    const sources = connectedOwnedCities(state, factionId, target.id).filter((city) => city.id !== target.id && city.garrison > 1);
    if (sources.reduce((sum, city) => sum + city.garrison - 1, 0) < 3) return "可集结兵力不足";
    if (faction.gold < mobilizeGoldCost || faction.food < mobilizeFoodCost) return "战略集结资源不足";
    return undefined;
  }

  if (action.type === "grand_assault") {
    if (state.cities.filter((city) => city.ownerFactionId === factionId).length < 7) return "控制至少 7 座城池才能发动天下总攻";
    if (!factionById(state, action.targetFactionId)?.alive || action.targetFactionId === factionId) return "总攻目标无效";
    if (faction.gold < grandAssaultGoldCost || faction.food < grandAssaultFoodCost) return "天下总攻资源不足";
    const hasFront = state.cities.some((source) => source.ownerFactionId === factionId && source.garrison >= 5 && source.adjacentCityIds.some((id) => cityById(state, id)?.ownerFactionId === action.targetFactionId));
    if (!hasFront) return "没有可发动总攻的前线";
    return undefined;
  }

  const source = cityById(state, action.sourceCityId);
  const target = cityById(state, action.targetCityId);
  if (!source || !target) return "城池不存在";
  if (source.ownerFactionId !== factionId) return "来源不是己方城池";
  if (!source.adjacentCityIds.includes(target.id)) return "目标城池不相邻";
  if (action.troops >= source.garrison) return "来源城必须至少保留 1 兵力";

  if (action.type === "transfer") {
    if (target.ownerFactionId !== factionId) return "调兵目标不是己方城池";
    return undefined;
  }

  if (source.occupationTurns > 0) return "新占领城池不能发动进攻";
  if (target.ownerFactionId === factionId) return "不能进攻己方城池";
  if (areAllied(state, factionId, target.ownerFactionId)) return "不能进攻盟友";
  if (areInCeasefire(state, factionId, target.ownerFactionId)) return "停战期间不能进攻对方";
  if (faction.food < action.troops) return "出征粮草不足";
  const maxTroops = Math.min(source.garrison - 1, faction.food);
  const minTroops = Math.max(4, Math.ceil(maxTroops * 0.6));
  if (action.troops < minTroops) return `进攻至少需要投入 ${minTroops} 兵力`;
  return undefined;
}

function addProposal(state: GameState, factionId: string, targetFactionId: string, type: "alliance" | "ceasefire" | "joint_attack", events: GameEvent[], enemyFactionId?: string) {
  const existing = state.proposals.some((item) => item.fromFactionId === factionId && item.toFactionId === targetFactionId && item.type === type && item.status === "pending");
  if (existing) return;
  state.proposals.push({ id: `proposal-${state.turn}-${type}-${factionId}-${targetFactionId}`, fromFactionId: factionId, toFactionId: targetFactionId, type, enemyFactionId, createdTurn: state.turn, status: "pending" });
  if (type === "ceasefire") return;
  const label = type === "alliance" ? "结盟" : `共同进攻 ${enemyFactionId}`;
  events.push({ type: `${type}_proposed`, turn: state.turn, factionId, message: `${factionId} 向 ${targetFactionId} 提议${label}` });
}

function resolveCharacterInitiative(state: GameState, factionId: string, initiative: NonNullable<ModelDecision["diplomacy"]["initiative"]>, events: GameEvent[]) {
  if (!("characterId" in initiative)) return false;
  const actor = factionById(state, factionId)!;
  const character = state.characters.find((item) => item.id === initiative.characterId);
  if (!character) return true;
  if (initiative.type === "sow_discord") {
    if (actor.gold < 10 || character.status !== "active" || character.factionId !== initiative.targetFactionId) return true;
    if (character.defectionProtectedUntilTurn !== undefined && character.defectionProtectedUntilTurn >= state.turn) return true;
    actor.gold -= 10;
    character.loyalty = clamp(character.loyalty - 20);
    character.resentment = clamp(character.resentment + 10);
    events.push({ type: "sow_discord", turn: state.turn, factionId, message: `${factionId}暗中离间${character.name}，其忠诚下降` });
    const targetLeaderName = factionById(state, initiative.targetFactionId)?.leaderName;
    if (character.loyalty <= 30 && character.name !== targetLeaderName) {
      character.factionId = factionId;
      character.locationCityId = actor.capitalCityId;
      character.loyalty = 75;
      character.defectionProtectedUntilTurn = state.turn + 5;
      events.push({ type: "character_defected", turn: state.turn, factionId, message: `${character.name}叛离${initiative.targetFactionId}，转投${factionId}` });
    }
    return true;
  }
  if (character.status !== "captive" || character.capturedByFactionId !== factionId) return true;
  if (initiative.type === "recruit_captive") {
    if (character.name === factionById(state, character.originalFactionId)?.leaderName) {
      events.push({ type: "leader_refused_recruitment", turn: state.turn, factionId, message: `${character.name}身为一方主公，不会接受普通招降` });
      return true;
    }
    if (character.defectionProtectedUntilTurn !== undefined && character.defectionProtectedUntilTurn >= state.turn) return true;
    if (actor.gold < 8) return true;
    actor.gold -= 8;
    const originalAlive = factionById(state, character.originalFactionId)?.alive;
    if (!originalAlive || character.loyalty <= 50) {
      character.status = "active";
      character.factionId = factionId;
      character.locationCityId = actor.capitalCityId;
      character.capturedByFactionId = undefined;
      character.loyalty = 75;
      character.defectionProtectedUntilTurn = state.turn + 5;
      events.push({ type: "character_recruited", turn: state.turn, factionId, message: `${character.name}接受招降，转投${factionId}` });
    } else {
      character.loyalty = clamp(character.loyalty - 15);
      events.push({ type: "character_refused", turn: state.turn, factionId, message: `${character.name}拒绝${factionId}招降，忠诚受到动摇` });
    }
  } else if (initiative.type === "release_captive") {
    const home = factionById(state, character.originalFactionId);
    character.capturedByFactionId = undefined;
    if (home?.alive) {
      character.status = "active";
      character.factionId = home.id;
      character.locationCityId = home.capitalCityId;
    } else {
      character.status = "wandering";
      character.factionId = undefined;
      character.locationCityId = undefined;
    }
    actor.reputation = clamp((actor.reputation ?? 60) + 8);
    events.push({ type: "character_released", turn: state.turn, factionId, message: `${factionId}释放了${character.name}，声望提升` });
  } else if (initiative.type === "execute_captive") {
    character.status = "dead";
    character.factionId = undefined;
    character.locationCityId = undefined;
    character.capturedByFactionId = undefined;
    actor.reputation = clamp((actor.reputation ?? 60) - 20);
    events.push({ type: "character_executed", turn: state.turn, factionId, message: `${factionId}处决了${character.name}，天下震动，声望大降` });
  }
  return true;
}

function resolveDiplomacy(state: GameState, orders: Record<string, ModelDecision>, events: GameEvent[]) {
  const decisiveWar = isDecisiveWar(state);
  for (const [factionId, order] of Object.entries(orders)) {
    for (const response of order.diplomacy.responses) {
      const proposal = state.proposals.find((item) => item.id === response.proposalId && item.toFactionId === factionId && item.status === "pending");
      if (!proposal) continue;
      const accepted = response.decision === "accept" && !(decisiveWar && proposal.type === "alliance");
      proposal.status = accepted ? "accepted" : "rejected";
      const label = proposal.type === "alliance" ? "结盟" : proposal.type === "ceasefire" ? "停战" : "联合进攻";
      events.push({ type: "diplomacy_response", turn: state.turn, factionId, message: `${factionId}${accepted ? "接受" : "拒绝"}了 ${proposal.fromFactionId} 的${label}提议` });
      if (!accepted) continue;
      const relation = getRelation(state, proposal.fromFactionId, proposal.toFactionId);
      relation.trust = clamp((relation.trust ?? 50) + 10);
      if (proposal.type === "alliance") {
        relation.scheduledStatus = "alliance";
        relation.scheduledTurn = state.turn + 1;
        relation.allianceUntilTurn = state.turn + 4;
      } else if (proposal.type === "ceasefire") {
        relation.status = "neutral";
        relation.ceasefireUntilTurn = state.turn + 3;
      } else if (proposal.enemyFactionId && factionById(state, proposal.enemyFactionId)?.alive) {
        state.jointOperations.push({ factionAId: proposal.fromFactionId, factionBId: proposal.toFactionId, enemyFactionId: proposal.enemyFactionId, untilTurn: state.turn + 2 });
      }
    }

    const initiative = order.diplomacy.initiative;
    if (!initiative || initiative.targetFactionId === factionId || !factionById(state, initiative.targetFactionId)?.alive) continue;
    if (resolveCharacterInitiative(state, factionId, initiative, events)) continue;
    const target = factionById(state, initiative.targetFactionId)!;
    const relation = findRelation(state, factionId, target.id) ?? { factionAId: factionId, factionBId: target.id, status: "neutral" as const, trust: 50 };
    if (initiative.type === "message") {
      events.push({ type: "diplomatic_message", turn: state.turn, factionId, message: `${factionId} 对 ${target.id} 表示：${initiative.message ?? ""}` });
    } else if (initiative.type === "propose_alliance" && !decisiveWar && !areAllied(state, factionId, target.id)) {
      addProposal(state, factionId, target.id, "alliance", events);
    } else if (initiative.type === "propose_ceasefire") {
      addProposal(state, factionId, target.id, "ceasefire", events);
    } else if (initiative.type === "propose_joint_attack" && initiative.enemyFactionId !== factionId && initiative.enemyFactionId !== target.id && factionById(state, initiative.enemyFactionId)?.alive) {
      addProposal(state, factionId, target.id, "joint_attack", events, initiative.enemyFactionId);
    } else if (initiative.type === "break_alliance" && areAllied(state, factionId, target.id)) {
      relation.scheduledStatus = "neutral";
      relation.scheduledTurn = state.turn + 1;
      events.push({ type: "alliance_break_announced", turn: state.turn, factionId, message: `${factionId} 宣布将在下一回合解除与 ${target.id} 的同盟` });
    } else if (initiative.type === "betray_alliance" && areAllied(state, factionId, target.id)) {
      relation.status = "neutral";
      relation.trust = 0;
      delete relation.allianceUntilTurn;
      actorReputation(state, factionId, -25);
      events.push({ type: "alliance_betrayed", turn: state.turn, factionId, message: `${factionId}突然背盟，转而对${target.id}动手，声望大降` });
    } else if (initiative.type === "betray_ceasefire" && areInCeasefire(state, factionId, target.id)) {
      delete relation.ceasefireUntilTurn;
      relation.trust = 0;
      actorReputation(state, factionId, -20);
      events.push({ type: "ceasefire_betrayed", turn: state.turn, factionId, message: `${factionId}撕毁停战，突袭${target.id}，声望大降` });
    } else if (initiative.type === "offer_gold") {
      const actor = factionById(state, factionId)!;
      if (actor.gold >= initiative.amount) {
        actor.gold -= initiative.amount;
        target.gold += initiative.amount;
        relation.trust = clamp((relation.trust ?? 50) + 8);
        events.push({ type: "gold_offered", turn: state.turn, factionId, message: `${factionId}向${target.id}献上 ${initiative.amount} 金` });
      }
    } else if (initiative.type === "lend_troops") {
      const source = cityById(state, initiative.sourceCityId);
      const destination = cityById(state, initiative.targetCityId);
      if (source?.ownerFactionId === factionId && destination?.ownerFactionId === target.id && source.garrison > initiative.troops && areAllied(state, factionId, target.id)) {
        source.garrison -= initiative.troops;
        destination.garrison += initiative.troops;
        relation.trust = clamp((relation.trust ?? 50) + 12);
        events.push({ type: "troops_lent", turn: state.turn, factionId, message: `${factionId}借给${target.id} ${initiative.troops} 兵，增援${destination.name}` });
      }
    } else if (initiative.type === "cede_city") {
      const city = cityById(state, initiative.cityId);
      const owned = state.cities.filter((item) => item.ownerFactionId === factionId);
      if (city?.ownerFactionId === factionId && city.id !== factionById(state, factionId)?.capitalCityId && owned.length > 1) {
        city.ownerFactionId = target.id;
        city.occupationTurns = 1;
        relation.trust = clamp((relation.trust ?? 50) + 25);
        actorReputation(state, factionId, -5);
        events.push({ type: "city_ceded", turn: state.turn, factionId, message: `${factionId}将${city.name}割让给${target.id}` });
      }
    }
  }
}

function actorReputation(state: GameState, factionId: string, change: number) {
  const faction = factionById(state, factionId);
  if (faction) faction.reputation = clamp((faction.reputation ?? 60) + change);
}

function resolveInternalAction(state: GameState, factionId: string, action: MainAction, events: GameEvent[]) {
  const faction = factionById(state, factionId)!;
  if (action.type === "rest" || action.type === "attack" || action.type === "grand_assault") return;
  if (action.type === "develop_city" || action.type === "develop_commerce" || action.type === "develop_agriculture") {
    const city = cityById(state, action.cityId)!;
    const specialization = action.type === "develop_city" ? action.specialization : action.type === "develop_commerce" ? "commerce" : "agriculture";
    faction.gold -= developmentCost;
    city.specialization = specialization;
    city.specializationLevel += 1;
    if (specialization === "commerce") city.goldIncome += 3;
    if (specialization === "agriculture") {
      city.foodIncome += 4;
      if (city.specializationLevel === 2) city.manpowerCapacity += 2;
    }
    events.push({ type: "develop_city", turn: state.turn, factionId, message: `${factionId} 将${city.name}建设为${specialization === "commerce" ? "商贸" : specialization === "agriculture" ? "农桑" : "军镇"}专精 ${city.specializationLevel} 级` });
  } else if (action.type === "recruit") {
    const city = cityById(state, action.cityId)!;
    faction.gold -= action.troops * 2;
    faction.food -= action.troops;
    city.manpower -= action.troops;
    city.garrison += action.troops;
    events.push({ type: "recruit", turn: state.turn, factionId, message: `${factionId} 在${city.name}征募 ${action.troops} 兵力` });
  } else if (action.type === "forced_levy") {
    const city = cityById(state, action.cityId)!;
    faction.gold -= action.troops * forcedLevyGoldCost;
    faction.food -= action.troops * forcedLevyFoodCost;
    city.garrison += action.troops;
    city.lastForcedLevyTurn = state.turn;
    if (city.specialization && city.specializationLevel > 0) {
      const removedLevel = city.specializationLevel;
      if (city.specialization === "commerce") city.goldIncome = Math.max(0, city.goldIncome - 3);
      if (city.specialization === "agriculture") {
        city.foodIncome = Math.max(0, city.foodIncome - 4);
        if (removedLevel === 2) {
          city.manpowerCapacity = Math.max(0, city.manpowerCapacity - 2);
          city.manpower = Math.min(city.manpower, city.manpowerCapacity);
        }
      }
      city.specializationLevel -= 1;
      if (city.specializationLevel === 0) city.specialization = null;
    } else {
      city.unrestTurns = 3;
    }
    events.push({ type: "forced_levy", turn: state.turn, factionId, message: `${factionId} 在${city.name}强征 ${action.troops} 兵力，城市发展受损` });
  } else if (action.type === "fortify") {
    const city = cityById(state, action.cityId)!;
    faction.gold -= 6;
    faction.food -= 4;
    city.defenseLevel += 1;
    events.push({ type: "fortify", turn: state.turn, factionId, message: `${factionId} 加固了${city.name}城防` });
  } else if (action.type === "transfer") {
    const source = cityById(state, action.sourceCityId)!;
    const target = cityById(state, action.targetCityId)!;
    if (source.ownerFactionId !== factionId || target.ownerFactionId !== factionId || action.troops >= source.garrison) {
      events.push({ type: "transfer_cancelled", turn: state.turn, factionId, message: `${factionId}的调兵因战场局势变化而取消` });
      return;
    }
    source.garrison -= action.troops;
    target.garrison += action.troops;
    events.push({
      type: "transfer",
      turn: state.turn,
      factionId,
      message: `${factionId} 从${source.name}向${target.name}调动 ${action.troops} 兵力`,
      payload: { sourceCityId: source.id, targetCityId: target.id, troops: action.troops }
    });
  } else if (action.type === "mobilize") {
    const target = cityById(state, action.targetCityId)!;
    if (target.ownerFactionId !== factionId || faction.gold < mobilizeGoldCost || faction.food < mobilizeFoodCost) {
      events.push({ type: "mobilize_cancelled", turn: state.turn, factionId, message: `${factionId}的战略集结因战场局势变化而取消` });
      return;
    }
    let remaining = 8;
    let moved = 0;
    const movements: Array<{ source: CityState; troops: number }> = [];
    const sources = connectedOwnedCities(state, factionId, target.id).filter((city) => city.id !== target.id && city.garrison > 1).sort((a, b) => b.garrison - a.garrison || a.id.localeCompare(b.id));
    for (const source of sources) {
      const troops = Math.min(remaining, source.garrison - 1);
      movements.push({ source, troops });
      moved += troops;
      remaining -= troops;
      if (remaining === 0) break;
    }
    if (moved < 3) {
      events.push({ type: "mobilize_cancelled", turn: state.turn, factionId, message: `${factionId}的战略集结因可调兵力不足而取消` });
      return;
    }
    for (const movement of movements) movement.source.garrison -= movement.troops;
    target.garrison += moved;
    faction.gold -= mobilizeGoldCost;
    faction.food -= mobilizeFoodCost;
    events.push({ type: "mobilize", turn: state.turn, factionId, message: `${factionId}向${target.name}战略集结 ${moved} 兵` });
  }
}

function siegeFor(state: GameState, attackerFactionId: string, targetCityId: string) {
  return state.sieges.find((siege) => siege.attackerFactionId === attackerFactionId && siege.targetCityId === targetCityId);
}

function siegeProgress(state: GameState, attackerFactionId: string, targetCityId: string) {
  return siegeFor(state, attackerFactionId, targetCityId)?.progress ?? 0;
}

function applySiegePressure(state: GameState, attackerFactionId: string, targetCityId: string, increase: number) {
  let siege = siegeFor(state, attackerFactionId, targetCityId);
  if (!siege && increase > 0) {
    siege = { attackerFactionId, targetCityId, progress: 0, lastPressureTurn: state.turn };
    state.sieges.push(siege);
  }
  if (!siege) return 0;
  siege.progress = Math.min(3, siege.progress + increase);
  siege.lastPressureTurn = state.turn;
  return siege.progress;
}

function clearCitySieges(state: GameState, cityId: string) {
  state.sieges = state.sieges.filter((siege) => siege.targetCityId !== cityId);
}

function resolveCharactersAfterCapture(state: GameState, defenderFactionId: string, cityId: string, attackerFactionId: string, events: GameEvent[]) {
  const stationed = state.characters.filter((character) => character.status === "active" && character.factionId === defenderFactionId && character.locationCityId === cityId);
  const captured = stationed[0];
  if (captured) {
    captured.status = "captive";
    captured.capturedByFactionId = attackerFactionId;
    captured.locationCityId = cityId;
    captured.loyalty = clamp(captured.loyalty - 10);
    events.push({ type: "character_captured", turn: state.turn, factionId: attackerFactionId, message: `${captured.name}在城破后被${attackerFactionId}俘虏` });
  }
  const retreat = state.cities.find((city) => city.ownerFactionId === defenderFactionId);
  for (const character of stationed.slice(captured ? 1 : 0)) {
    if (retreat) character.locationCityId = retreat.id;
    else {
      character.status = "wandering";
      character.factionId = undefined;
      character.locationCityId = undefined;
    }
  }
}

function resolveBattleDeath(state: GameState, factionId: string, cityId: string, losses: number, events: GameEvent[]) {
  if (losses < 8) return;
  const leaderName = factionById(state, factionId)?.leaderName;
  const character = state.characters.find((item) => item.status === "active" && item.factionId === factionId && item.locationCityId === cityId && item.name !== leaderName);
  if (!character) return;
  character.status = "dead";
  character.factionId = undefined;
  character.locationCityId = undefined;
  events.push({ type: "character_fallen", turn: state.turn, factionId, message: `${character.name}在惨烈战斗中阵亡` });
}

function defensePowerAgainst(state: GameState, attackerFactionId: string, target: CityState) {
  const progress = siegeProgress(state, attackerFactionId, target.id);
  return target.garrison * (1 + target.defenseLevel * 0.2) * (1 - progress * 0.08);
}

function resolveAttack(state: GameState, factionId: string, action: Extract<MainAction, { type: "attack" }>, events: GameEvent[], capturedCityIds: Set<string>, coordinated: boolean) {
  const faction = factionById(state, factionId)!;
  const source = cityById(state, action.sourceCityId);
  const target = cityById(state, action.targetCityId);
  if (!source || !target || source.ownerFactionId !== factionId || action.troops >= source.garrison) {
    events.push({ type: "attack_cancelled", turn: state.turn, factionId, message: `${factionId} 的出征因来源城局势变化而取消`, payload: { sourceCityId: action.sourceCityId, targetCityId: action.targetCityId, troops: action.troops } });
    return;
  }
  if (target.ownerFactionId === factionId || areAllied(state, factionId, target.ownerFactionId)) {
    events.push({ type: "attack_cancelled", turn: state.turn, factionId, message: `${factionId} 的出征因目标归属变化而取消`, payload: { sourceCityId: action.sourceCityId, targetCityId: action.targetCityId, troops: action.troops } });
    return;
  }
  if (faction.food < action.troops) {
    events.push({ type: "attack_cancelled", turn: state.turn, factionId, message: `${factionId} 的出征因粮草不足而取消`, payload: { sourceCityId: action.sourceCityId, targetCityId: action.targetCityId, troops: action.troops } });
    return;
  }

  const defenderFactionId = target.ownerFactionId;
  faction.food -= action.troops;
  source.garrison -= action.troops;
  const attackPower = action.troops * (coordinated ? 1.1 : 1);
  const defensePower = defensePowerAgainst(state, factionId, target);
  const requiredAdvantage = captureAdvantage(state);

  if (attackPower >= defensePower * requiredAdvantage) {
    const lossRate = (0.2 + 0.2 * (defensePower / attackPower)) * (coordinated ? 0.8 : 1);
    const attackerLoss = Math.min(action.troops, Math.ceil(action.troops * lossRate));
    const survivors = Math.max(1, action.troops - attackerLoss);
    target.ownerFactionId = factionId;
    target.garrison = survivors;
    target.captureCount = (target.captureCount ?? 0) + 1;
    target.defenseLevel = Math.max(0, target.defenseLevel - 1);
    if (target.captureCount >= 3) {
      target.garrison += 2;
      target.defenseLevel = Math.max(1, target.defenseLevel);
      events.push({ type: "city_pacified", turn: state.turn, factionId, message: `${target.name}多次易手后地方势力归附，补充 2 兵并恢复 1 级城防` });
    }
    target.occupationTurns = 2;
    target.unrestTurns = 0;
    clearCitySieges(state, target.id);
    capturedCityIds.add(target.id);
    state.director.lastCaptureTurn = state.turn;
    getRelation(state, factionId, defenderFactionId).status = "war";
    events.push({ type: "city_captured", turn: state.turn, factionId, message: `${factionId} 攻占${target.name}，损失 ${attackerLoss} 兵力${coordinated ? "，获得联合进攻加成" : ""}`, payload: { cityId: target.id, defenderFactionId, sourceCityId: source.id, targetCityId: target.id, troops: action.troops } });
    resolveBattleDeath(state, factionId, source.id, attackerLoss, events);
    resolveCharactersAfterCapture(state, defenderFactionId, target.id, factionId, events);
  } else {
    const attackerLoss = Math.min(action.troops, Math.ceil(action.troops * 0.6));
    const defenderLossRate = 0.2 + 0.2 * (attackPower / defensePower);
    const defenderLoss = Math.min(Math.max(0, target.garrison - 1), Math.ceil(target.garrison * defenderLossRate));
    target.garrison -= defenderLoss;
    const meaningfulAttack = attackPower >= defensePower * 0.5;
    const defenseDamaged = meaningfulAttack && target.defenseLevel > 0;
    if (defenseDamaged) target.defenseLevel -= 1;
    const progress = meaningfulAttack ? applySiegePressure(state, factionId, target.id, defenseDamaged ? 0 : 1) : siegeProgress(state, factionId, target.id);
    source.garrison += action.troops - attackerLoss;
    getRelation(state, factionId, defenderFactionId).status = "war";
    events.push({ type: "attack_repulsed", turn: state.turn, factionId, message: `${factionId} 进攻${target.name}失败，进攻方损失 ${attackerLoss}，守方损失 ${defenderLoss}${defenseDamaged ? "，城防降低 1 级" : meaningfulAttack ? `，围城进度升至 ${progress}/3` : ""}`, payload: { sourceCityId: source.id, targetCityId: target.id, troops: action.troops } });
    resolveBattleDeath(state, factionId, source.id, attackerLoss, events);
    resolveBattleDeath(state, defenderFactionId, target.id, defenderLoss, events);
  }
}

function resolveGrandAssault(state: GameState, factionId: string, targetFactionId: string, events: GameEvent[], capturedCityIds: Set<string>) {
  const faction = factionById(state, factionId)!;
  faction.gold -= grandAssaultGoldCost;
  faction.food -= 20;
  events.push({ type: "grand_assault", turn: state.turn, factionId, message: `${factionId}耗费国力，对${targetFactionId}发动天下总攻` });
  const usedSources = new Set<string>();
  for (let index = 0; index < 2; index += 1) {
    const route = state.cities.flatMap((source) => source.ownerFactionId === factionId && source.occupationTurns === 0 && source.garrison >= 5 && !usedSources.has(source.id)
      ? source.adjacentCityIds.map((targetId) => ({ source, target: cityById(state, targetId) })).filter((item) => item.target?.ownerFactionId === targetFactionId)
      : []).sort((a, b) => b.source.garrison - a.source.garrison || a.source.id.localeCompare(b.source.id))[0];
    if (!route?.target) break;
    const troops = Math.min(route.source.garrison - 1, faction.food, 12);
    if (troops < 4) break;
    usedSources.add(route.source.id);
    resolveAttack(state, factionId, { type: "attack", sourceCityId: route.source.id, targetCityId: route.target.id, troops }, events, capturedCityIds, true);
  }
}

function coordinatedAttackers(state: GameState, orders: Record<string, ModelDecision>, targetOwners: Map<string, string>) {
  const coordinated = new Set<string>();
  for (const operation of state.jointOperations.filter((item) => item.untilTurn >= state.turn)) {
    const attacksEnemy = (factionId: string) => {
      const action = orders[factionId]?.action;
      return action?.type === "grand_assault" ? action.targetFactionId === operation.enemyFactionId : action?.type === "attack" && targetOwners.get(action.targetCityId) === operation.enemyFactionId;
    };
    if (attacksEnemy(operation.factionAId) && attacksEnemy(operation.factionBId)) {
      coordinated.add(operation.factionAId);
      coordinated.add(operation.factionBId);
    }
  }
  return coordinated;
}

function evaluateJointOperations(state: GameState, orders: Record<string, ModelDecision>, targetOwners: Map<string, string>, events: GameEvent[]) {
  const remaining = [];
  for (const operation of state.jointOperations) {
    const attacksEnemy = (factionId: string) => {
      const action = orders[factionId]?.action;
      return action?.type === "grand_assault" ? action.targetFactionId === operation.enemyFactionId : action?.type === "attack" && targetOwners.get(action.targetCityId) === operation.enemyFactionId;
    };
    const first = attacksEnemy(operation.factionAId);
    const second = attacksEnemy(operation.factionBId);
    if (!first && !second && operation.untilTurn > state.turn) {
      remaining.push(operation);
      continue;
    }
    const relation = getRelation(state, operation.factionAId, operation.factionBId);
    if (first && second) {
      relation.trust = clamp((relation.trust ?? 50) + 15);
      events.push({ type: "joint_attack_honored", turn: state.turn, message: `${operation.factionAId}与${operation.factionBId}兑现承诺，共同进攻${operation.enemyFactionId}` });
    } else {
      const betrayer = first ? operation.factionBId : operation.factionAId;
      relation.trust = clamp((relation.trust ?? 50) - 25);
      actorReputation(state, betrayer, -8);
      const intent = orders[betrayer]?.secretIntent;
      events.push({ type: "joint_attack_broken", turn: state.turn, factionId: betrayer, message: `${betrayer}未兑现共同进攻承诺${intent === "feint" ? "，原来只是佯攻" : ""}` });
    }
  }
  state.jointOperations = remaining;
}

function checkVictory(state: GameState): VictoryResult {
  for (const faction of state.factions) faction.alive = state.cities.some((city) => city.ownerFactionId === faction.id);
  for (const character of state.characters.filter((item) => item.status === "active" && item.factionId && !factionById(state, item.factionId)?.alive)) {
    character.status = "wandering";
    character.factionId = undefined;
    character.locationCityId = undefined;
  }
  const alive = state.factions.filter((faction) => faction.alive);
  state.domination = { consecutiveTurns: 0 };
  if (alive.length === 1) return { finished: true, winnerFactionId: alive[0]!.id, reason: `${alive[0]!.id} 控制全部 ${state.cities.length} 座城池，完成一统` };
  return { finished: false };
}

function resolveFactionCollapse(state: GameState, events: GameEvent[]) {
  if (!isDecisiveWar(state)) return;
  const alive = state.factions.filter((faction) => faction.alive);
  const ranked = alive.map((faction) => {
    const cities = state.cities.filter((city) => city.ownerFactionId === faction.id);
    return { faction, cities, troops: cities.reduce((sum, city) => sum + city.garrison, 0) };
  }).sort((a, b) => b.cities.length - a.cities.length || b.troops - a.troops);
  const leader = ranked[0];
  const weakest = ranked[ranked.length - 1];
  if (!leader || !weakest || leader.faction.id === weakest.faction.id) return;

  const capitalHeld = weakest.cities.some((city) => city.id === weakest.faction.capitalCityId);
  const collapsing = weakest.cities.length <= 2 && !capitalHeld && weakest.troops <= weakest.cities.length * 2;
  weakest.faction.collapseTurns = collapsing ? (weakest.faction.collapseTurns ?? 0) + 1 : 0;
  for (const item of ranked.slice(0, -1)) item.faction.collapseTurns = 0;
  if (!collapsing) return;

  const activeCharacters = state.characters.filter((character) => character.status === "active" && character.factionId === weakest.faction.id).length;
  const threshold = activeCharacters === 0 ? 2 : 3;
  events.push({ type: "faction_collapse_pressure", turn: state.turn, factionId: weakest.faction.id, message: `${weakest.faction.id}首都失守、兵微将寡，崩溃进度 ${weakest.faction.collapseTurns}/${threshold}` });
  if ((weakest.faction.collapseTurns ?? 0) < threshold) return;

  for (const city of weakest.cities) {
    city.ownerFactionId = leader.faction.id;
    city.garrison = Math.max(1, Math.ceil(city.garrison / 2));
    city.occupationTurns = 1;
    city.unrestTurns = Math.max(city.unrestTurns, 1);
    clearCitySieges(state, city.id);
  }
  weakest.faction.alive = false;
  events.push({ type: "faction_collapsed", turn: state.turn, factionId: weakest.faction.id, message: `${weakest.faction.id}军心瓦解，余下城池向${leader.faction.id}归降` });
}

function resolveCaptiveSuccession(state: GameState, events: GameEvent[]) {
  for (const character of state.characters.filter((item) => item.status === "captive" && item.capturedByFactionId && !factionById(state, item.capturedByFactionId)?.alive)) {
    const cityOwner = character.locationCityId ? cityById(state, character.locationCityId)?.ownerFactionId : undefined;
    if (cityOwner && factionById(state, cityOwner)?.alive && cityOwner !== character.originalFactionId) {
      character.capturedByFactionId = cityOwner;
      events.push({ type: "captive_transferred", turn: state.turn, factionId: cityOwner, message: `${character.name}因原俘虏方灭亡，转由${cityOwner}接管` });
      continue;
    }
    const home = factionById(state, character.originalFactionId);
    character.capturedByFactionId = undefined;
    if (home?.alive) {
      character.status = "active";
      character.factionId = home.id;
      character.locationCityId = home.capitalCityId;
      events.push({ type: "captive_released", turn: state.turn, factionId: home.id, message: `${character.name}因俘虏方灭亡重获自由，返回${home.id}` });
    } else {
      character.status = "wandering";
      character.factionId = undefined;
      character.locationCityId = undefined;
      events.push({ type: "captive_wandering", turn: state.turn, message: `${character.name}因俘虏方灭亡脱离囚禁，流落在野` });
    }
  }
}

export function resolveTurn(input: GameState, inputOrders: Record<string, ModelDecision>, priority = getTurnPriority(input)): ResolveTurnResult {
  const state = normalizeGameState(input);
  const events: GameEvent[] = [];
  const acceptedOrders: Record<string, ModelDecision> = {};
  const invalidOrders: Record<string, string> = {};

  for (const faction of state.factions.filter((item) => item.alive)) {
    const parsed = modelDecisionSchema.safeParse(inputOrders[faction.id] ?? restDecision("未提交命令"));
    const decision = parsed.success ? parsed.data : restDecision("命令格式错误");
    let error = validateAction(state, faction.id, decision.action);
    if (decision.action.type === "attack") {
      const targetOwner = cityById(state, decision.action.targetCityId)?.ownerFactionId;
      const initiative = decision.diplomacy.initiative;
      if (error === "不能进攻盟友" && initiative?.type === "betray_alliance" && initiative.targetFactionId === targetOwner) error = undefined;
      if (error === "停战期间不能进攻对方" && initiative?.type === "betray_ceasefire" && initiative.targetFactionId === targetOwner) error = undefined;
    }
    if (error) {
      invalidOrders[faction.id] = error;
      acceptedOrders[faction.id] = { ...decision, action: { type: "rest" }, reasonSummary: `${decision.reasonSummary}（命令非法：${error}，改为休整）` };
    } else {
      acceptedOrders[faction.id] = decision;
    }
  }

  const targetOwners = new Map(state.cities.map((city) => [city.id, city.ownerFactionId]));
  resolveDiplomacy(state, acceptedOrders, events);
  for (const factionId of priority) {
    const action = acceptedOrders[factionId]?.action ?? { type: "rest" };
    if (action.type !== "transfer" && action.type !== "mobilize") resolveInternalAction(state, factionId, action, events);
  }

  const capturedCityIds = new Set<string>();
  const coordinated = coordinatedAttackers(state, acceptedOrders, targetOwners);
  for (const factionId of priority) {
    const action = acceptedOrders[factionId]?.action;
    if (action?.type === "attack") resolveAttack(state, factionId, action, events, capturedCityIds, coordinated.has(factionId));
    if (action?.type === "grand_assault") resolveGrandAssault(state, factionId, action.targetFactionId, events, capturedCityIds);
  }
  for (const factionId of priority) {
    const action = acceptedOrders[factionId]?.action;
    if (action?.type === "transfer" || action?.type === "mobilize") resolveInternalAction(state, factionId, action, events);
  }
  evaluateJointOperations(state, acceptedOrders, targetOwners, events);

  for (const city of state.cities) {
    if (city.occupationTurns > 0 && !capturedCityIds.has(city.id)) city.occupationTurns -= 1;
    if (city.unrestTurns > 0) city.unrestTurns -= 1;
  }

  resolveFactionCollapse(state, events);
  const victory = checkVictory(state);
  resolveCaptiveSuccession(state, events);
  if (victory.finished) {
    state.winnerFactionId = victory.winnerFactionId;
    state.finishReason = victory.reason;
    if (state.audience.predictedWinnerFactionId) state.audience.predictionCorrect = state.audience.predictedWinnerFactionId === victory.winnerFactionId;
    events.push({ type: "game_finished", turn: state.turn, factionId: victory.winnerFactionId, message: `游戏结束：${victory.reason}` });
  }
  return { state, events, acceptedOrders, invalidOrders, victory };
}

function buildBorderThreats(state: GameState, factionId: string): BorderThreat[] {
  const threats: BorderThreat[] = [];
  const requiredAdvantage = captureAdvantage(state);
  for (const city of state.cities.filter((item) => item.ownerFactionId === factionId)) {
    for (const enemyCity of state.cities.filter((item) => item.ownerFactionId !== factionId && item.adjacentCityIds.includes(city.id))) {
      if (areAllied(state, factionId, enemyCity.ownerFactionId)) continue;
      const defensePower = defensePowerAgainst(state, enemyCity.ownerFactionId, city);
      const requiredCapturePower = defensePower * requiredAdvantage;
      const enemyFaction = factionById(state, enemyCity.ownerFactionId);
      const maxAttackPower = Math.max(0, Math.min(enemyCity.garrison - 1, enemyFaction?.food ?? 0));
      if (maxAttackPower < 2) continue;
      threats.push({
        cityId: city.id,
        defensePower,
        enemyFactionId: enemyCity.ownerFactionId,
        enemyCityId: enemyCity.id,
        maxAttackPower,
        requiredCapturePower,
        capturePossible: maxAttackPower >= requiredCapturePower
      });
    }
  }
  return threats.sort((a, b) => Number(b.capturePossible) - Number(a.capturePossible) || b.maxAttackPower / b.requiredCapturePower - a.maxAttackPower / a.requiredCapturePower);
}

function buildLegalDiplomacy(state: GameState, factionId: string): DiplomacyInitiative[] {
  const actor = factionById(state, factionId);
  if (!actor?.alive) return [];
  const alive = state.factions.filter((faction) => faction.alive);
  const others = alive.filter((faction) => faction.id !== factionId);
  const cityCount = (id: string) => state.cities.filter((city) => city.ownerFactionId === id).length;
  const options: DiplomacyInitiative[] = [];
  for (const target of others) {
    const relation = getRelation(state, factionId, target.id);
    if (!isDecisiveWar(state) && relation.status !== "alliance") options.push({ type: "propose_alliance", targetFactionId: target.id });
    if (relation.status === "war" || relation.ceasefireUntilTurn === undefined && cityCount(actor.id) <= 2) options.push({ type: "propose_ceasefire", targetFactionId: target.id });
    if (relation.status === "alliance") {
      const source = state.cities.filter((city) => city.ownerFactionId === factionId && city.garrison >= 4).sort((a, b) => b.garrison - a.garrison)[0];
      const destination = state.cities.filter((city) => city.ownerFactionId === target.id).sort((a, b) => a.garrison - b.garrison)[0];
      if (source && destination) options.push({ type: "lend_troops", targetFactionId: target.id, sourceCityId: source.id, targetCityId: destination.id, troops: Math.min(5, source.garrison - 1) });
      if (state.cities.some((sourceCity) => sourceCity.ownerFactionId === factionId && sourceCity.adjacentCityIds.some((id) => cityById(state, id)?.ownerFactionId === target.id))) options.push({ type: "betray_alliance", targetFactionId: target.id });
    }
  }
  if (alive.length === 3) {
    const enemy = [...others].sort((a, b) => cityCount(b.id) - cityCount(a.id))[0];
    const partner = others.find((faction) => faction.id !== enemy?.id);
    if (enemy && partner) options.push({ type: "propose_joint_attack", targetFactionId: partner.id, enemyFactionId: enemy.id });
  }
  const weakestOther = [...others].sort((a, b) => cityCount(a.id) - cityCount(b.id))[0];
  if (weakestOther && actor.gold >= 30) options.push({ type: "offer_gold", targetFactionId: weakestOther.id, amount: 20 });
  if (weakestOther && cityCount(actor.id) <= 2 && cityCount(weakestOther.id) > cityCount(actor.id)) {
    const cedable = state.cities.find((city) => city.ownerFactionId === actor.id && city.id !== actor.capitalCityId);
    if (cedable) options.push({ type: "cede_city", targetFactionId: weakestOther.id, cityId: cedable.id });
  }
  for (const character of state.characters.filter((item) => item.status === "captive" && item.capturedByFactionId === factionId)) {
    options.push({ type: "release_captive", targetFactionId: character.originalFactionId, characterId: character.id });
    options.push({ type: "execute_captive", targetFactionId: character.originalFactionId, characterId: character.id });
    if (character.name !== factionById(state, character.originalFactionId)?.leaderName && (character.defectionProtectedUntilTurn ?? -1) < state.turn) options.push({ type: "recruit_captive", targetFactionId: character.originalFactionId, characterId: character.id });
  }
  if (actor.gold >= 10) {
    const targetCharacter = state.characters.find((character) => character.status === "active" && character.factionId && character.factionId !== factionId && character.name !== factionById(state, character.factionId)?.leaderName && character.loyalty <= 60 && (character.defectionProtectedUntilTurn ?? -1) < state.turn);
    if (targetCharacter?.factionId) options.push({ type: "sow_discord", targetFactionId: targetCharacter.factionId, characterId: targetCharacter.id });
  }
  return options.slice(0, 12);
}

export function buildObservation(state: GameState, factionId: string, priority: string[], recentEvents: GameEvent[], privateMemory: string): Observation {
  const faction = factionById(state, factionId);
  if (!faction) throw new Error(`Faction not found: ${factionId}`);
  const observedState = clone(state);
  observedState.proposals = observedState.proposals.filter((proposal) => proposal.fromFactionId === factionId || proposal.toFactionId === factionId || proposal.status !== "pending");
  observedState.audience.orders = observedState.audience.orders.filter((order) => order.resolved);
  return {
    factionId,
    leaderName: faction.leaderName,
    persona: faction.persona,
    turn: state.turn,
    stage: getGameStage(state.turn),
    decisiveWar: isDecisiveWar(state),
    priority,
    state: observedState,
    legalActions: listLegalActions(state, factionId),
    recentEvents: clone(recentEvents),
    privateMemory,
    pendingProposals: state.proposals.filter((proposal) => proposal.toFactionId === factionId && proposal.status === "pending"),
    legalDiplomacy: buildLegalDiplomacy(state, factionId),
    borderThreats: buildBorderThreats(state, factionId)
  };
}
