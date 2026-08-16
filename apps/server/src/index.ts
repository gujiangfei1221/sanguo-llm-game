import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import dotenv from "dotenv";
import { GameDatabase } from "./database.js";
import { GameService } from "./game-service.js";
import { rootDirectory, webDistDirectory } from "./paths.js";

dotenv.config({ path: resolve(rootDirectory, ".env.local") });
dotenv.config({ path: resolve(rootDirectory, ".env") });

const server = Fastify({ logger: true });
await server.register(cors, { origin: true });

const database = new GameDatabase();
const service = new GameService(database);

const handle = (handler: (request: FastifyRequest, reply: FastifyReply) => unknown) => async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    return await handler(request, reply);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(400).send({ error: message });
  }
};

server.get("/api/health", async () => ({ ok: true, harnessMode: process.env.HARNESS_MODE ?? "pi", provider: process.env.PI_PROVIDER ?? "ark-coding" }));
server.get("/api/config/models", async () => service.models);
server.get("/api/games", async () => service.listGames());
server.post("/api/games", handle(async (request) => service.createGame(request.body)));
server.get("/api/games/:gameId", handle(async (request) => service.getGame((request.params as { gameId: string }).gameId)));
server.post("/api/games/:gameId/start", handle(async (request) => service.advance((request.params as { gameId: string }).gameId)));
server.post("/api/games/:gameId/advance", handle(async (request) => service.advance((request.params as { gameId: string }).gameId)));
server.post("/api/games/:gameId/auto-play", handle(async (request) => service.setAutoPlay((request.params as { gameId: string }).gameId, Boolean((request.body as { enabled?: boolean })?.enabled))));
server.post("/api/games/:gameId/pause", handle(async (request) => service.setAutoPlay((request.params as { gameId: string }).gameId, false)));
server.post("/api/games/:gameId/orders", handle(async (request) => service.submitHumanOrder((request.params as { gameId: string }).gameId, request.body)));
server.post("/api/games/:gameId/audience", handle(async (request) => service.submitAudienceOrder((request.params as { gameId: string }).gameId, request.body)));
server.post("/api/games/:gameId/factions/:factionId/controller", handle(async (request) => {
  const params = request.params as { gameId: string; factionId: string };
  return service.updateController(params.gameId, params.factionId, request.body);
}));
server.post("/api/games/:gameId/turns/:turn/retry/:factionId", handle(async (request) => {
  const params = request.params as { gameId: string; factionId: string };
  return service.retry(params.gameId, params.factionId);
}));
server.post("/api/games/:gameId/turns/:turn/force-rest/:factionId", handle(async (request) => {
  const params = request.params as { gameId: string; factionId: string };
  return service.forceRest(params.gameId, params.factionId);
}));
server.post("/api/games/:gameId/resume", handle(async (request) => service.resume((request.params as { gameId: string }).gameId)));

server.get("/api/games/:gameId/events", async (request, reply) => {
  const gameId = (request.params as { gameId: string }).gameId;
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*"
  });
  reply.raw.write(`event: connected\ndata: ${JSON.stringify({ gameId })}\n\n`);
  const unsubscribe = service.subscribe(gameId, ({ type, data }) => {
    reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  });
  const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15000);
  request.raw.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

if (existsSync(webDistDirectory)) {
  await server.register(fastifyStatic, { root: webDistDirectory });
  server.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile("index.html");
  });
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
await server.listen({ port, host });
