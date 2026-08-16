import { describe, expect, it } from "vitest";
import { buildObservation, createInitialState, getFactionResourceCaps, listLegalActions, normalizeGameState, prepareTurn, resolveTurn, validateAction, type ScenarioDefinition } from "../src/index.js";

const scenario: ScenarioDefinition = {
  id: "test",
  maxTurns: 10,
  factions: [
    { id: "a", name: "A", leaderName: "A", persona: "", gold: 20, food: 30, alive: true, capitalCityId: "a1" },
    { id: "b", name: "B", leaderName: "B", persona: "", gold: 20, food: 30, alive: true, capitalCityId: "b1" }
  ],
  cities: [
    { id: "a1", name: "A1", ownerFactionId: "a", goldIncome: 4, foodIncome: 6, manpower: 6, manpowerCapacity: 10, manpowerRecovery: 2, garrison: 10, defenseLevel: 0, specialization: null, specializationLevel: 0, unrestTurns: 0, occupationTurns: 0, adjacentCityIds: ["b1"] },
    { id: "b1", name: "B1", ownerFactionId: "b", goldIncome: 4, foodIncome: 6, manpower: 6, manpowerCapacity: 10, manpowerRecovery: 2, garrison: 3, defenseLevel: 0, specialization: null, specializationLevel: 0, unrestTurns: 0, occupationTurns: 0, adjacentCityIds: ["a1"] }
  ]
};

const decision = (action: Parameters<typeof validateAction>[2]) => ({
  action,
  diplomacy: { responses: [] },
  secretIntent: "none" as const,
  publicMessage: "",
  reasonSummary: "test",
  privateMemory: "test"
});

function addThirdFaction(state: ReturnType<typeof createInitialState>) {
  state.factions.push({ id: "c", name: "C", leaderName: "C", persona: "", gold: 20, food: 30, alive: true, capitalCityId: "c1" });
  state.cities.push({ id: "c1", name: "C1", ownerFactionId: "c", goldIncome: 4, foodIncome: 6, manpower: 6, manpowerCapacity: 10, manpowerRecovery: 2, garrison: 5, defenseLevel: 0, specialization: null, specializationLevel: 0, unrestTurns: 0, occupationTurns: 0, adjacentCityIds: [] });
}

describe("game engine", () => {
  it("prepares income and upkeep deterministically", () => {
    const state = createInitialState(scenario);
    const first = prepareTurn(state);
    const second = prepareTurn(state);
    expect(first).toEqual(second);
    expect(first.state.turn).toBe(1);
    expect(first.state.factions[0]?.gold).toBe(24);
    expect(first.state.factions[0]?.food).toBe(33);
  });

  it("slows and then stops manpower recovery in the late game", () => {
    const state = createInitialState(scenario);
    state.turn = 8;
    state.cities[0]!.manpower = 0;
    expect(prepareTurn(state).state.cities[0]?.manpower).toBe(1);

    state.turn = 18;
    state.cities[0]!.manpower = 0;
    expect(prepareTurn(state).state.cities[0]?.manpower).toBe(0);
  });

  it("locks a city into one specialization", () => {
    const prepared = prepareTurn(createInitialState(scenario));
    const result = resolveTurn(prepared.state, {
      a: decision({ type: "develop_city", cityId: "a1", specialization: "commerce" }),
      b: decision({ type: "rest" })
    });
    const city = result.state.cities.find((item) => item.id === "a1")!;
    expect(city.specialization).toBe("commerce");
    expect(city.specializationLevel).toBe(1);
    expect(city.goldIncome).toBe(7);
    expect(validateAction(result.state, "a", { type: "develop_city", cityId: "a1", specialization: "agriculture" })).toContain("其他专精");
  });

  it("caps stockpiled resources after upkeep", () => {
    const state = createInitialState(scenario);
    state.factions[0]!.gold = 500;
    state.factions[0]!.food = 500;
    const prepared = prepareTurn(state);
    const faction = prepared.state.factions[0]!;
    const caps = getFactionResourceCaps(prepared.state, "a");
    expect(faction.gold).toBe(caps.gold);
    expect(faction.food).toBe(caps.food);
    expect(prepared.events.some((event) => event.type === "resource_overflow" && event.factionId === "a")).toBe(true);
  });

  it("charges administration after expanding beyond three cities", () => {
    const state = createInitialState(scenario);
    for (let index = 2; index <= 4; index += 1) {
      state.cities.push({ ...state.cities[0]!, id: `a${index}`, name: `A${index}`, adjacentCityIds: [], garrison: 1 });
    }
    const prepared = prepareTurn(state);
    expect(prepared.events).toContainEqual(expect.objectContaining({ type: "administration_paid", factionId: "a", message: expect.stringContaining("3 金、4 粮") }));
  });

  it("allows costly forced levies only in the decisive stage", () => {
    const state = createInitialState(scenario);
    state.turn = 18;
    const prepared = prepareTurn(state);
    const city = prepared.state.cities.find((item) => item.id === "a1")!;
    city.specialization = "commerce";
    city.specializationLevel = 1;
    city.goldIncome = 7;
    city.garrison = 2;
    const beforeGold = prepared.state.factions[0]!.gold;
    const beforeFood = prepared.state.factions[0]!.food;
    const beforeTroops = city.garrison;
    const result = resolveTurn(prepared.state, {
      a: decision({ type: "forced_levy", cityId: "a1", troops: 3 }),
      b: decision({ type: "rest" })
    });
    const afterCity = result.state.cities.find((item) => item.id === "a1")!;
    expect(afterCity.garrison).toBe(beforeTroops + 3);
    expect(afterCity.specialization).toBeNull();
    expect(result.state.factions[0]!.gold).toBe(beforeGold - 24);
    expect(result.state.factions[0]!.food).toBe(beforeFood - 18);
    expect(validateAction(createInitialState(scenario), "a", { type: "forced_levy", cityId: "a1", troops: 1 })).toContain("决战");
  });

  it("publishes and enforces the minimum attack commitment", () => {
    const prepared = prepareTurn(createInitialState(scenario));
    const attack = listLegalActions(prepared.state, "a").find((action) => action.type === "attack");
    expect(attack).toEqual(expect.objectContaining({ routes: [expect.objectContaining({ minTroops: 6, maxTroops: 9 })] }));
    expect(validateAction(prepared.state, "a", { type: "attack", sourceCityId: "a1", targetCityId: "b1", troops: 5 })).toContain("至少需要投入 6");
  });

  it("rejects moving every troop out of a city", () => {
    const state = createInitialState(scenario);
    expect(validateAction(state, "a", { type: "attack", sourceCityId: "a1", targetCityId: "b1", troops: 10 })).toContain("保留");
  });

  it("publishes transfer route details after resolution", () => {
    const state = createInitialState(scenario);
    state.cities.push({ ...state.cities[0]!, id: "a2", name: "A2", garrison: 3, adjacentCityIds: ["a1"] });
    state.cities[0]!.adjacentCityIds.push("a2");
    const result = resolveTurn(state, {
      a: decision({ type: "transfer", sourceCityId: "a1", targetCityId: "a2", troops: 4 }),
      b: decision({ type: "rest" })
    });
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "transfer",
      factionId: "a",
      payload: { sourceCityId: "a1", targetCityId: "a2", troops: 4 }
    }));
  });

  it("resolves attacks before same-turn reinforcements arrive", () => {
    const state = createInitialState(scenario);
    state.cities.find((city) => city.id === "a1")!.garrison = 3;
    state.cities.find((city) => city.id === "b1")!.garrison = 10;
    state.cities.push({ ...state.cities[0]!, id: "a2", name: "A2", garrison: 8, adjacentCityIds: ["a1"] });
    state.cities.find((city) => city.id === "a1")!.adjacentCityIds.push("a2");
    const result = resolveTurn(state, {
      a: decision({ type: "transfer", sourceCityId: "a2", targetCityId: "a1", troops: 6 }),
      b: decision({ type: "attack", sourceCityId: "b1", targetCityId: "a1", troops: 8 })
    }, ["b", "a"]);
    expect(result.state.cities.find((city) => city.id === "a1")?.ownerFactionId).toBe("b");
    expect(result.state.cities.find((city) => city.id === "a2")?.garrison).toBe(8);
    expect(result.events.some((event) => event.type === "transfer_cancelled")).toBe(true);
  });

  it("migrates the basic route from Jiangzhou-Jianye to Jiangzhou-Chaisang", () => {
    const state = createInitialState(scenario);
    state.rulesetVersion = "2.2.0";
    state.scenarioId = "basic";
    state.cities[0] = { ...state.cities[0]!, id: "jiangzhou", adjacentCityIds: ["jianye"] };
    state.cities[1] = { ...state.cities[1]!, id: "jianye", adjacentCityIds: ["jiangzhou", "chaisang"] };
    state.cities.push({ ...state.cities[1]!, id: "chaisang", adjacentCityIds: ["jianye"] });
    const migrated = normalizeGameState(state);
    expect(migrated.cities.find((city) => city.id === "jiangzhou")?.adjacentCityIds).toContain("chaisang");
    expect(migrated.cities.find((city) => city.id === "jiangzhou")?.adjacentCityIds).not.toContain("jianye");
    expect(migrated.cities.find((city) => city.id === "jianye")?.adjacentCityIds).not.toContain("jiangzhou");
    expect(validateAction(migrated, "a", { type: "attack", sourceCityId: "jiangzhou", targetCityId: "jianye", troops: 4 })).toBe("目标城池不相邻");
  });

  it("captures a weaker adjacent city", () => {
    const prepared = prepareTurn(createInitialState(scenario));
    const result = resolveTurn(prepared.state, {
      a: decision({ type: "attack", sourceCityId: "a1", targetCityId: "b1", troops: 8 }),
      b: decision({ type: "rest" })
    }, ["a", "b"]);
    expect(result.state.cities.find((city) => city.id === "b1")?.ownerFactionId).toBe("a");
    expect(result.events).toContainEqual(expect.objectContaining({ type: "city_captured", payload: expect.objectContaining({ sourceCityId: "a1", targetCityId: "b1", troops: 8 }) }));
    expect(result.victory.finished).toBe(true);
    expect(result.victory.winnerFactionId).toBe("a");
  });

  it("requires a twenty percent advantage to capture a city", () => {
    const prepared = prepareTurn(createInitialState(scenario));
    addThirdFaction(prepared.state);
    const attacker = prepared.state.cities.find((city) => city.id === "a1")!;
    const defender = prepared.state.cities.find((city) => city.id === "b1")!;
    attacker.garrison = 5;
    defender.defenseLevel = 1;
    const result = resolveTurn(prepared.state, {
      a: decision({ type: "attack", sourceCityId: "a1", targetCityId: "b1", troops: 4 }),
      b: decision({ type: "rest" })
    }, ["a", "b"]);
    expect(result.state.cities.find((city) => city.id === "b1")?.ownerFactionId).toBe("b");
  });

  it("reduces capture advantage to five percent in decisive war", () => {
    const prepared = prepareTurn(createInitialState(scenario));
    prepared.state.cities.find((city) => city.id === "a1")!.garrison = 12;
    prepared.state.cities.find((city) => city.id === "b1")!.garrison = 10;
    const result = resolveTurn(prepared.state, {
      a: decision({ type: "attack", sourceCityId: "a1", targetCityId: "b1", troops: 11 }),
      b: decision({ type: "rest" })
    }, ["a", "b"]);
    expect(result.state.cities.find((city) => city.id === "b1")?.ownerFactionId).toBe("a");
  });

  it("damages defenses after a meaningful failed attack", () => {
    const prepared = prepareTurn(createInitialState(scenario));
    prepared.state.cities.find((city) => city.id === "a1")!.garrison = 8;
    const defender = prepared.state.cities.find((city) => city.id === "b1")!;
    defender.garrison = 10;
    defender.defenseLevel = 1;
    const result = resolveTurn(prepared.state, {
      a: decision({ type: "attack", sourceCityId: "a1", targetCityId: "b1", troops: 6 }),
      b: decision({ type: "rest" })
    }, ["a", "b"]);
    expect(result.state.cities.find((city) => city.id === "b1")?.defenseLevel).toBe(0);
  });

  it("builds and later decays siege progress when defenses are already broken", () => {
    const prepared = prepareTurn(createInitialState(scenario));
    prepared.state.cities.find((city) => city.id === "a1")!.garrison = 8;
    const defender = prepared.state.cities.find((city) => city.id === "b1")!;
    defender.garrison = 10;
    defender.defenseLevel = 0;
    const result = resolveTurn(prepared.state, {
      a: decision({ type: "attack", sourceCityId: "a1", targetCityId: "b1", troops: 6 }),
      b: decision({ type: "rest" })
    }, ["a", "b"]);
    expect(result.state.sieges).toEqual([expect.objectContaining({ attackerFactionId: "a", targetCityId: "b1", progress: 1 })]);
    const next = prepareTurn(result.state);
    expect(next.state.sieges).toHaveLength(1);
    const later = prepareTurn(next.state);
    expect(later.state.sieges).toHaveLength(1);
    const decayed = prepareTurn(later.state);
    expect(decayed.state.sieges).toHaveLength(0);
  });

  it("limits a faction to two last-stand interventions", () => {
    const state = createInitialState(scenario);
    state.turn = 10;
    for (let index = 2; index <= 4; index += 1) state.cities.push({ ...state.cities[0]!, id: `a${index}`, name: `A${index}`, adjacentCityIds: [], garrison: 2 });
    state.director.lastStandCounts = { b: 2 };
    const prepared = prepareTurn(state);
    expect(prepared.events.some((event) => event.type === "director_last_stand")).toBe(false);
  });

  it("collapses a capital-less remnant after sustained weakness", () => {
    const state = createInitialState(scenario);
    state.turn = 20;
    state.cities.find((city) => city.id === "b1")!.ownerFactionId = "a";
    state.cities.push({ ...state.cities[1]!, id: "b2", name: "B2", ownerFactionId: "b", garrison: 1, adjacentCityIds: [] });
    const first = resolveTurn(state, { a: decision({ type: "rest" }), b: decision({ type: "rest" }) });
    expect(first.state.factions.find((faction) => faction.id === "b")?.collapseTurns).toBe(1);
    const second = resolveTurn(first.state, { a: decision({ type: "rest" }), b: decision({ type: "rest" }) });
    expect(second.events.some((event) => event.type === "faction_collapsed")).toBe(true);
    expect(second.victory).toEqual(expect.objectContaining({ finished: true, winnerFactionId: "a" }));
  });

  it("applies world weariness once after turn thirty", () => {
    const state = createInitialState(scenario);
    state.turn = 30;
    state.cities.forEach((city) => { city.defenseLevel = 2; });
    const first = prepareTurn(state);
    expect(first.state.cities.every((city) => city.defenseLevel === 1)).toBe(true);
    const second = prepareTurn(first.state);
    expect(second.state.cities.every((city) => city.defenseLevel === 1)).toBe(true);
  });

  it("does not damage defenses with a small harassment attack", () => {
    const prepared = prepareTurn(createInitialState(scenario));
    prepared.state.cities.find((city) => city.id === "a1")!.garrison = 6;
    const defender = prepared.state.cities.find((city) => city.id === "b1")!;
    defender.garrison = 10;
    defender.defenseLevel = 1;
    const result = resolveTurn(prepared.state, {
      a: decision({ type: "attack", sourceCityId: "a1", targetCityId: "b1", troops: 5 }),
      b: decision({ type: "rest" })
    }, ["a", "b"]);
    expect(result.state.cities.find((city) => city.id === "b1")?.defenseLevel).toBe(1);
  });

  it("exposes immediate border threats to the model", () => {
    const state = createInitialState(scenario);
    state.cities.find((city) => city.id === "a1")!.garrison = 4;
    state.cities.find((city) => city.id === "b1")!.garrison = 8;
    const observation = buildObservation(state, "a", ["a", "b"], [], "");
    expect(observation.borderThreats).toEqual([expect.objectContaining({ cityId: "a1", enemyCityId: "b1", capturePossible: true })]);
  });

  it("does not end when one faction only controls a majority", () => {
    const state = createInitialState(scenario);
    addThirdFaction(state);
    state.cities.find((city) => city.id === "b1")!.ownerFactionId = "a";
    const result = resolveTurn(state, { a: decision({ type: "rest" }), b: decision({ type: "rest" }), c: decision({ type: "rest" }) });
    expect(result.victory.finished).toBe(false);
  });

  it("turns an illegal command into rest", () => {
    const prepared = prepareTurn(createInitialState(scenario));
    const result = resolveTurn(prepared.state, {
      a: decision({ type: "recruit", cityId: "a1", troops: 5 }),
      b: decision({ type: "develop_commerce", cityId: "a1" })
    });
    expect(result.invalidOrders.b).toBeDefined();
    expect(result.acceptedOrders.b?.action.type).toBe("rest");
  });

  it("executes material diplomacy and immediate betrayal", () => {
    const state = createInitialState(scenario);
    state.relations.push({ factionAId: "a", factionBId: "b", status: "alliance", trust: 80, allianceUntilTurn: 4 });
    state.factions[0]!.gold = 40;
    const result = resolveTurn(state, {
      a: { ...decision({ type: "attack", sourceCityId: "a1", targetCityId: "b1", troops: 8 }), diplomacy: { responses: [], initiative: { type: "betray_alliance", targetFactionId: "b" } }, secretIntent: "feint" },
      b: decision({ type: "rest" })
    }, ["a", "b"]);
    expect(result.state.cities.find((city) => city.id === "b1")?.ownerFactionId).toBe("a");
    expect(result.state.factions.find((faction) => faction.id === "a")?.reputation).toBe(35);
    expect(result.events.some((event) => event.type === "alliance_betrayed")).toBe(true);
  });

  it("applies spectator support on the following turn", () => {
    const state = createInitialState(scenario);
    state.audience.orders.push({ id: "order", submittedTurn: 0, type: "support", targetFactionId: "a", resolved: false });
    const prepared = prepareTurn(state);
    expect(prepared.state.factions.find((faction) => faction.id === "a")?.gold).toBe(34);
    expect(prepared.events.some((event) => event.type === "audience_support")).toBe(true);
  });

  it("captures a stationed character when a city falls", () => {
    const state = createInitialState(scenario);
    state.characters.push({ id: "hero", name: "名将", originalFactionId: "b", factionId: "b", locationCityId: "b1", status: "active", loyalty: 80, resentment: 0 });
    const result = resolveTurn(state, {
      a: decision({ type: "attack", sourceCityId: "a1", targetCityId: "b1", troops: 8 }),
      b: decision({ type: "rest" })
    }, ["a", "b"]);
    expect(result.state.characters[0]).toEqual(expect.objectContaining({ status: "captive", capturedByFactionId: "a", loyalty: 70 }));
    expect(result.events.some((event) => event.type === "character_captured")).toBe(true);
  });

  it("keeps other factions pending diplomacy out of observations", () => {
    const state = createInitialState(scenario);
    state.proposals.push({ id: "secret", fromFactionId: "b", toFactionId: "c", type: "ceasefire", createdTurn: 1, status: "pending" });
    expect(buildObservation(state, "a", ["a", "b"], [], "").state.proposals).toHaveLength(0);
  });

  it("can kill a non-leader character in a catastrophic battle", () => {
    const state = createInitialState(scenario);
    state.cities.find((city) => city.id === "a1")!.garrison = 14;
    state.cities.find((city) => city.id === "b1")!.garrison = 20;
    state.characters.push({ id: "officer", name: "偏将", originalFactionId: "a", factionId: "a", locationCityId: "a1", status: "active", loyalty: 70, resentment: 0 });
    const result = resolveTurn(state, {
      a: decision({ type: "attack", sourceCityId: "a1", targetCityId: "b1", troops: 12 }),
      b: decision({ type: "rest" })
    }, ["a", "b"]);
    expect(result.state.characters[0]?.status).toBe("dead");
    expect(result.events.some((event) => event.type === "character_fallen")).toBe(true);
  });

  it("mobilizes troops from connected rear cities in one action", () => {
    const state = createInitialState(scenario);
    state.turn = 8;
    state.cities.push({ ...state.cities[0]!, id: "a2", name: "A2", garrison: 6, adjacentCityIds: ["a1"] });
    state.cities[0]!.adjacentCityIds.push("a2");
    const prepared = prepareTurn(state).state;
    const before = prepared.cities.find((city) => city.id === "a1")!.garrison;
    const result = resolveTurn(prepared, { a: decision({ type: "mobilize", targetCityId: "a1" }), b: decision({ type: "rest" }) });
    expect(result.state.cities.find((city) => city.id === "a1")!.garrison).toBeGreaterThanOrEqual(before + 5);
    expect(result.events.some((event) => event.type === "mobilize")).toBe(true);
  });

  it("allows a seven-city faction to launch a grand assault", () => {
    const state = createInitialState(scenario);
    for (let index = 2; index <= 7; index += 1) state.cities.push({ ...state.cities[0]!, id: `a${index}`, name: `A${index}`, garrison: 2, adjacentCityIds: [] });
    state.factions[0]!.gold = 100;
    state.factions[0]!.food = 100;
    const result = resolveTurn(state, { a: decision({ type: "grand_assault", targetFactionId: "b" }), b: decision({ type: "rest" }) });
    expect(result.events.some((event) => event.type === "grand_assault")).toBe(true);
    expect(result.state.cities.find((city) => city.id === "b1")?.ownerFactionId).toBe("a");
  });

  it("does not allow an enemy leader to accept ordinary recruitment", () => {
    const state = createInitialState(scenario);
    state.characters.push({ id: "leader-b", name: "B", originalFactionId: "b", factionId: "b", locationCityId: "a1", status: "captive", loyalty: 20, resentment: 0, capturedByFactionId: "a" });
    const result = resolveTurn(state, {
      a: { ...decision({ type: "rest" }), diplomacy: { responses: [], initiative: { type: "recruit_captive", targetFactionId: "b", characterId: "leader-b" } } },
      b: decision({ type: "rest" })
    });
    expect(result.state.characters[0]?.status).toBe("captive");
    expect(result.events.some((event) => event.type === "leader_refused_recruitment")).toBe(true);
  });

  it("releases a captive when its captor is eliminated", () => {
    const state = createInitialState(scenario);
    state.characters.push({ id: "captive-a", name: "旧将", originalFactionId: "a", factionId: "a", locationCityId: "b1", status: "captive", loyalty: 60, resentment: 0, capturedByFactionId: "b" });
    const result = resolveTurn(state, {
      a: decision({ type: "attack", sourceCityId: "a1", targetCityId: "b1", troops: 8 }),
      b: decision({ type: "rest" })
    }, ["a", "b"]);
    expect(result.state.characters[0]).toEqual(expect.objectContaining({ status: "active", factionId: "a", capturedByFactionId: undefined }));
    expect(result.events.some((event) => event.type === "captive_released")).toBe(true);
  });

  it("provides concrete diplomacy candidates instead of an open enum", () => {
    const state = createInitialState(scenario);
    const observation = buildObservation(state, "a", ["a", "b"], [], "");
    expect(observation.legalDiplomacy).toContainEqual({ type: "propose_ceasefire", targetFactionId: "b" });
  });
});
