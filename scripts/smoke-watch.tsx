import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import reactDefault from "react";

(globalThis as { React?: unknown }).React = reactDefault;

const { WatchBoard } = await import("../apps/web/src/watch.tsx");

const file = process.argv[2] ?? "apps/web/public/replays/fd746659-fa67-466c-951f-fd211504b24e.json";
const replay = JSON.parse(readFileSync(file, "utf8")) as { name: string; config: unknown; turns: Array<{ turn: number; phase: string; state: unknown; events: unknown[] }> };

function render(turnIndex: number) {
  const turn = replay.turns[turnIndex]!;
  const events = replay.turns.slice(0, turnIndex + 1).flatMap((t) => t.events);
  const html = renderToString(createElement(WatchBoard, {
    game: { name: replay.name, phase: turn.phase, turn: turn.turn, state: turn.state, config: replay.config, events } as never,
    onClose: () => {}
  }));
  return { turn: turn.turn, phase: turn.phase, html };
}

const first = render(0);
const mid = render(Math.floor(replay.turns.length / 2));
const last = render(replay.turns.length - 1);

for (const [label, r] of [["first", first], ["mid", mid], ["last", last]] as const) {
  const checks = [
    r.html.includes("问鼎") ? "brand" : "NO-BRAND",
    r.html.includes("天下态势图") ? "map" : "NO-MAP",
    r.html.includes("战局日志") ? "log" : "NO-LOG",
    r.html.includes("三方态势") ? "factions" : "NO-FACTIONS",
    r.html.includes("合法行动") ? "legal" : "NO-LEGAL"
  ].join(" ");
  console.log(`${label} (第${r.turn}回合 ${r.phase}): ${r.html.length} chars | ${checks}`);
}
if (last.phase === "FINISHED" && !last.html.includes("天下归一")) console.log("WARN: 最后一回合未渲染终局横幅");
console.log("smoke ok");
