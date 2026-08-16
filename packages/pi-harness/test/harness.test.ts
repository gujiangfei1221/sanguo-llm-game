import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Observation } from "@sanguo/shared";
import { PiHarness, testing } from "../src/index.js";

const decision = {
  action: { type: "rest" },
  diplomacy: { responses: [] },
  publicMessage: "",
  reasonSummary: "等待时机",
  privateMemory: "继续观察"
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createFakePi(successAfter: number | undefined) {
  const directory = await mkdtemp(join(tmpdir(), "sanguo-fake-pi-"));
  temporaryDirectories.push(directory);
  const command = join(directory, "fake-pi.mjs");
  const counterPath = join(directory, "counter.txt");
  const callsPath = join(directory, "calls.jsonl");
  const script = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const counterPath = ${JSON.stringify(counterPath)};
const callsPath = ${JSON.stringify(callsPath)};
const count = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) + 1 : 1;
writeFileSync(counterPath, String(count));
appendFileSync(callsPath, JSON.stringify(process.argv.slice(2)) + "\\n");
const decision = ${JSON.stringify(decision)};
if (${successAfter ?? "undefined"} !== undefined && count >= ${successAfter ?? "undefined"}) {
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(decision) }] } }));
} else {
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "继续分析局势" + count }] } }));
}
`;
  await writeFile(command, script);
  await chmod(command, 0o755);
  return { command, callsPath };
}

const observation = {
  leaderName: "曹操",
  persona: "审时度势",
  stage: "MUSTER",
  turn: 1,
  factionId: "wei",
  privateMemory: "",
  decisiveWar: false,
  legalActions: [],
  legalDiplomacy: [],
  state: { cities: [] }
} as unknown as Observation;

describe("Pi JSONL parser", () => {
  it("extracts the final assistant text", () => {
    const output = [
      JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "prompt" }] } }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: JSON.stringify(decision) }], usage: { totalTokens: 12 } } })
    ].join("\n");
    expect(testing.extractDecision(output).decision.privateMemory).toBe("继续观察");
  });

  it("reconstructs assistant text when Pi omits message_end", () => {
    const serialized = JSON.stringify(decision);
    const output = [
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: serialized.slice(0, 20) } }),
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: serialized.slice(20) } })
    ].join("\n");
    expect(testing.extractDecision(output).decision.reasonSummary).toBe("等待时机");
  });

  it("accepts fenced JSON defensively", () => {
    expect(testing.parseJsonText(`\`\`\`json\n${JSON.stringify(decision)}\n\`\`\``)).toEqual(decision);
  });

  it("normalizes common model field variants", () => {
    const output = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: JSON.stringify({
          decision: {
            action: { type: "attack", source_city_id: "a", target_city_id: "b", troops: 2 },
            public_message: "出征",
            reason: "邻城空虚"
          }
        }) }]
      }
    });
    const parsed = testing.extractDecision(output, "旧记忆").decision;
    expect(parsed.action).toEqual({ type: "attack", sourceCityId: "a", targetCityId: "b", troops: 2 });
    expect(parsed.privateMemory).toBe("旧记忆");
  });

  it("drops an invalid optional initiative without losing the main action", () => {
    const output = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: JSON.stringify({
          action: { type: "recruit", cityId: "jianye", troops: 3 },
          diplomacy: { responses: [], initiative: { type: "none" } },
          secretIntent: "honor_promise",
          reasonSummary: "补充兵力",
          privateMemory: "守住江东"
        }) }]
      }
    });
    const parsed = testing.extractDecision(output).decision;
    expect(parsed.action).toEqual({ type: "recruit", cityId: "jianye", troops: 3 });
    expect(parsed.diplomacy.initiative).toBeUndefined();
    expect(parsed.secretIntent).toBe("honor_promise");
  });

  it("normalizes snake case diplomacy fields", () => {
    const output = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: JSON.stringify({
          action: { type: "rest" },
          diplomacy: { initiative: { type: "propose_joint_attack", target_faction_id: "shu", enemy_faction_id: "wei" } },
          reasonSummary: "联蜀攻魏",
          privateMemory: "等待回应"
        }) }]
      }
    });
    expect(testing.extractDecision(output).decision.diplomacy.initiative).toEqual({ type: "propose_joint_attack", targetFactionId: "shu", enemyFactionId: "wei" });
  });

  it("continues the same session after thinking-only responses", async () => {
    const fakePi = await createFakePi(3);
    const harness = new PiHarness({
      command: fakePi.command,
      timeoutMs: 5_000,
      maxAttempts: 1,
      thinkingOnlyMaxAttempts: 3
    });

    const result = await harness.decide({ modelId: "fake-model", observation });
    expect(result.attempts).toBe(3);
    expect(result.decision.reasonSummary).toBe("等待时机");

    const calls = (await readFile(fakePi.callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(calls).toHaveLength(3);
    const sessionIds = calls.map((args) => args[args.indexOf("--session-id") + 1]);
    expect(new Set(sessionIds).size).toBe(1);
    expect(calls[1]?.at(-1)).toContain("上一轮");
    expect(calls[2]?.at(-1)).toContain("第 3/3 次请求");
  });

  it("stops after three thinking-only responses", async () => {
    const fakePi = await createFakePi(undefined);
    const harness = new PiHarness({
      command: fakePi.command,
      timeoutMs: 5_000,
      maxAttempts: 2,
      thinkingOnlyMaxAttempts: 3
    });

    await expect(harness.decide({ modelId: "fake-model", observation })).rejects.toThrow("连续 3 次只输出 thinking");
    const calls = (await readFile(fakePi.callsPath, "utf8")).trim().split("\n");
    expect(calls).toHaveLength(3);
  });
});
