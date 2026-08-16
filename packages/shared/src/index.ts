import { z } from "zod";

export const factionControllerSchema = z.enum(["model", "human"]);
export type FactionController = z.infer<typeof factionControllerSchema>;

export const gamePhaseSchema = z.enum([
  "DRAFT",
  "WAITING_TO_ADVANCE",
  "PREPARING",
  "COLLECTING_ORDERS",
  "ORDERS_LOCKED",
  "RESOLVING",
  "PUBLISHING",
  "BLOCKED",
  "FINISHED"
]);
export type GamePhase = z.infer<typeof gamePhaseSchema>;

export const gameStageSchema = z.enum(["MUSTER", "CONTEST", "DECISIVE"]);
export type GameStage = z.infer<typeof gameStageSchema>;

export const citySpecializationSchema = z.enum(["commerce", "agriculture", "military"]);
export type CitySpecialization = z.infer<typeof citySpecializationSchema>;

export const mainActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("rest") }),
  z.object({ type: z.literal("develop_city"), cityId: z.string(), specialization: citySpecializationSchema }),
  z.object({ type: z.literal("develop_commerce"), cityId: z.string() }),
  z.object({ type: z.literal("develop_agriculture"), cityId: z.string() }),
  z.object({ type: z.literal("recruit"), cityId: z.string(), troops: z.number().int().min(1).max(7) }),
  z.object({ type: z.literal("forced_levy"), cityId: z.string(), troops: z.number().int().min(1).max(3) }),
  z.object({ type: z.literal("fortify"), cityId: z.string() }),
  z.object({ type: z.literal("transfer"), sourceCityId: z.string(), targetCityId: z.string(), troops: z.number().int().min(1) }),
  z.object({ type: z.literal("attack"), sourceCityId: z.string(), targetCityId: z.string(), troops: z.number().int().min(2) }),
  z.object({ type: z.literal("mobilize"), targetCityId: z.string() }),
  z.object({ type: z.literal("grand_assault"), targetFactionId: z.string() })
]);
export type MainAction = z.infer<typeof mainActionSchema>;

export const secretIntentSchema = z.enum(["none", "honor_promise", "feint", "separate_peace"]);
export type SecretIntent = z.infer<typeof secretIntentSchema>;

export const diplomacyInitiativeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), targetFactionId: z.string(), message: z.string().max(300).optional() }),
  z.object({ type: z.literal("propose_alliance"), targetFactionId: z.string(), message: z.string().max(300).optional() }),
  z.object({ type: z.literal("propose_ceasefire"), targetFactionId: z.string(), message: z.string().max(300).optional() }),
  z.object({ type: z.literal("propose_joint_attack"), targetFactionId: z.string(), enemyFactionId: z.string(), message: z.string().max(300).optional() }),
  z.object({ type: z.literal("break_alliance"), targetFactionId: z.string(), message: z.string().max(300).optional() }),
  z.object({ type: z.literal("betray_alliance"), targetFactionId: z.string(), message: z.string().max(300).optional() }),
  z.object({ type: z.literal("betray_ceasefire"), targetFactionId: z.string(), message: z.string().max(300).optional() }),
  z.object({ type: z.literal("offer_gold"), targetFactionId: z.string(), amount: z.number().int().min(5).max(30), message: z.string().max(300).optional() }),
  z.object({ type: z.literal("lend_troops"), targetFactionId: z.string(), sourceCityId: z.string(), targetCityId: z.string(), troops: z.number().int().min(1).max(5), message: z.string().max(300).optional() }),
  z.object({ type: z.literal("cede_city"), targetFactionId: z.string(), cityId: z.string(), message: z.string().max(300).optional() }),
  z.object({ type: z.literal("sow_discord"), targetFactionId: z.string(), characterId: z.string(), message: z.string().max(300).optional() }),
  z.object({ type: z.literal("recruit_captive"), targetFactionId: z.string(), characterId: z.string(), message: z.string().max(300).optional() }),
  z.object({ type: z.literal("release_captive"), targetFactionId: z.string(), characterId: z.string(), message: z.string().max(300).optional() }),
  z.object({ type: z.literal("execute_captive"), targetFactionId: z.string(), characterId: z.string(), message: z.string().max(300).optional() })
]);
export type DiplomacyInitiative = z.infer<typeof diplomacyInitiativeSchema>;

export const diplomacySchema = z.object({
  responses: z.array(z.object({
    proposalId: z.string(),
    decision: z.enum(["accept", "reject"])
  })).max(4).default([]),
  initiative: diplomacyInitiativeSchema.optional()
});

export const modelDecisionSchema = z.object({
  action: mainActionSchema,
  diplomacy: diplomacySchema.default({ responses: [] }),
  secretIntent: secretIntentSchema.default("none"),
  publicMessage: z.string().max(300).default(""),
  reasonSummary: z.string().max(500),
  privateMemory: z.string().max(1500)
});
export type ModelDecision = z.infer<typeof modelDecisionSchema>;

export interface FactionState {
  id: string;
  name: string;
  leaderName: string;
  persona: string;
  gold: number;
  food: number;
  alive: boolean;
  capitalCityId: string;
  reputation?: number;
  collapseTurns?: number;
}

export interface CityState {
  id: string;
  name: string;
  ownerFactionId: string;
  goldIncome: number;
  foodIncome: number;
  manpower: number;
  manpowerCapacity: number;
  manpowerRecovery: number;
  garrison: number;
  defenseLevel: number;
  specialization: CitySpecialization | null;
  specializationLevel: number;
  unrestTurns: number;
  lastForcedLevyTurn?: number;
  commerceLevel?: number;
  agricultureLevel?: number;
  occupationTurns: number;
  captureCount?: number;
  adjacentCityIds: string[];
}

export interface SiegeState {
  attackerFactionId: string;
  targetCityId: string;
  progress: number;
  lastPressureTurn: number;
}

export interface DiplomaticRelation {
  factionAId: string;
  factionBId: string;
  status: "neutral" | "alliance" | "war";
  allianceUntilTurn?: number;
  scheduledStatus?: "neutral" | "alliance";
  scheduledTurn?: number;
  trust?: number;
  ceasefireUntilTurn?: number;
}

export interface DiplomaticProposal {
  id: string;
  fromFactionId: string;
  toFactionId: string;
  type: "alliance" | "ceasefire" | "joint_attack";
  enemyFactionId?: string;
  createdTurn: number;
  status: "pending" | "accepted" | "rejected" | "expired";
}

export interface JointOperation {
  factionAId: string;
  factionBId: string;
  enemyFactionId: string;
  untilTurn: number;
}

export interface CharacterState {
  id: string;
  name: string;
  originalFactionId: string;
  factionId?: string;
  locationCityId?: string;
  status: "active" | "captive" | "wandering" | "dead";
  loyalty: number;
  capturedByFactionId?: string;
  resentment: number;
  defectionProtectedUntilTurn?: number;
}

export interface DirectorState {
  lastCaptureTurn: number;
  lastEventTurn: number;
  lastStandCounts?: Record<string, number>;
}

export interface AudienceOrder {
  id: string;
  submittedTurn: number;
  type: "support" | "rumor";
  targetFactionId: string;
  secondaryFactionId?: string;
  resolved: boolean;
}

export interface AudienceState {
  influence: number;
  lastInterventionTurn: number;
  orders: AudienceOrder[];
  predictedWinnerFactionId?: string;
  predictionTurn?: number;
  predictionCorrect?: boolean;
}

export interface DominationState {
  factionId?: string;
  consecutiveTurns: number;
}

export interface GameState {
  rulesetVersion: string;
  scenarioId: string;
  turn: number;
  maxTurns: number;
  factions: FactionState[];
  cities: CityState[];
  relations: DiplomaticRelation[];
  proposals: DiplomaticProposal[];
  jointOperations: JointOperation[];
  characters: CharacterState[];
  director: DirectorState;
  audience: AudienceState;
  domination: DominationState;
  sieges: SiegeState[];
  worldWearinessApplied: boolean;
  winnerFactionId?: string;
  finishReason?: string;
}

export type LegalAction =
  | { type: "rest" }
  | { type: "develop_city"; options: Array<{ cityId: string; specialization: CitySpecialization; nextLevel: number }> }
  | { type: "fortify"; cityIds: string[] }
  | { type: "recruit"; cities: Array<{ cityId: string; maxTroops: number }> }
  | { type: "forced_levy"; cities: Array<{ cityId: string; maxTroops: number; consequence: string }> }
  | { type: "transfer"; routes: Array<{ sourceCityId: string; targetCityId: string; maxTroops: number }> }
  | { type: "attack"; routes: Array<{ sourceCityId: string; targetCityId: string; minTroops: number; maxTroops: number; requiresBetrayal?: "alliance" | "ceasefire" }> }
  | { type: "mobilize"; targets: Array<{ targetCityId: string; sourceCityIds: string[]; maxTroops: number }> }
  | { type: "grand_assault"; targetFactionIds: string[] };

export interface GameEvent {
  type: string;
  turn: number;
  message: string;
  factionId?: string;
  payload?: Record<string, unknown>;
}

export interface BorderThreat {
  cityId: string;
  defensePower: number;
  enemyFactionId: string;
  enemyCityId: string;
  maxAttackPower: number;
  requiredCapturePower: number;
  capturePossible: boolean;
}

export interface Observation {
  factionId: string;
  leaderName: string;
  persona: string;
  turn: number;
  stage: GameStage;
  decisiveWar: boolean;
  priority: string[];
  state: GameState;
  legalActions: LegalAction[];
  recentEvents: GameEvent[];
  privateMemory: string;
  pendingProposals: DiplomaticProposal[];
  legalDiplomacy: DiplomacyInitiative[];
  borderThreats: BorderThreat[];
}

export interface VictoryResult {
  finished: boolean;
  winnerFactionId?: string;
  reason?: string;
}

export interface PrepareTurnResult {
  state: GameState;
  events: GameEvent[];
  priority: string[];
}

export interface ResolveTurnResult {
  state: GameState;
  events: GameEvent[];
  acceptedOrders: Record<string, ModelDecision>;
  invalidOrders: Record<string, string>;
  victory: VictoryResult;
}

export interface ModelConfig {
  id: string;
  name: string;
}

export interface FactionRuntimeConfig {
  factionId: string;
  controller: FactionController;
  modelId?: string;
}

export interface GameRuntimeConfig {
  name: string;
  factions: FactionRuntimeConfig[];
}

export const createGameSchema = z.object({
  name: z.string().min(1).max(80),
  factions: z.array(z.object({
    factionId: z.string(),
    controller: factionControllerSchema,
    modelId: z.string().optional()
  })).length(3)
});

export const humanOrderSchema = z.object({
  factionId: z.string(),
  decision: modelDecisionSchema
});

export const audienceOrderSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("support"), targetFactionId: z.string() }),
  z.object({ type: z.literal("rumor"), targetFactionId: z.string(), secondaryFactionId: z.string() }),
  z.object({ type: z.literal("predict"), targetFactionId: z.string() })
]);

export const controllerUpdateSchema = z.object({
  controller: factionControllerSchema,
  modelId: z.string().optional()
});
