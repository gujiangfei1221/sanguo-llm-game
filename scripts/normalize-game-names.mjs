// 将对局名归一化：剥离自动轮换累积的 "#N" 后缀，按创建顺序重新编号。
// 同时把 config_json 里的 name 归一为基础名，使后续轮换生成的新局名保持干净。
// 用法: node scripts/normalize-game-names.mjs [db路径]（默认 data/sanguo.db）
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

const dbPath = process.argv[2] ?? resolve(process.cwd(), "data/sanguo.db");
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout=5000");

const rows = db.prepare("SELECT id, name, config_json FROM games ORDER BY created_at").all();
const strip = (value) => value.replace(/\s+#\d+/g, "");
let changed = 0;
rows.forEach((row, index) => {
  const base = strip(row.name);
  const target = index === 0 ? base : `${base} #${index + 1}`;
  let config = null;
  try { config = JSON.parse(row.config_json); } catch { config = null; }
  const configNeedsFix = config && typeof config === "object" && config.name !== base;
  if (row.name !== target || configNeedsFix) {
    if (configNeedsFix) config.name = base;
    db.prepare("UPDATE games SET name = ?, config_json = ? WHERE id = ?").run(target, configNeedsFix ? JSON.stringify(config) : row.config_json, row.id);
    changed += 1;
  }
});
console.log(`[normalize] 共 ${rows.length} 局，修正 ${changed} 局名称`);
