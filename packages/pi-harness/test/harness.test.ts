import { describe, expect, it } from "vitest";
import { testing } from "../src/index.js";

const decision = {
  action: { type: "rest" },
  diplomacy: { responses: [] },
  publicMessage: "",
  reasonSummary: "等待时机",
  privateMemory: "继续观察"
};

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
});
