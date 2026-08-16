import { GameDatabase } from "./database.js";
import { ReplayExporter } from "./replay-exporter.js";

const database = new GameDatabase();
const exporter = new ReplayExporter(database);
exporter.exportAll();
console.log("[replay] 回放导出完成");
