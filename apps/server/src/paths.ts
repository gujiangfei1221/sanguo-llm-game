import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
export const rootDirectory = resolve(currentDirectory, "../../..");
export const dataDirectory = resolve(rootDirectory, "data");
export const webDistDirectory = resolve(rootDirectory, "apps/web/dist");
export const scenarioPath = resolve(rootDirectory, "scenarios/basic.json");
export const modelsPath = resolve(rootDirectory, "config/models.json");
export const autoRotateConfigPath = resolve(rootDirectory, "config/auto-rotate.json");
export const replaysDirectory = resolve(rootDirectory, "apps/web/public/replays");
