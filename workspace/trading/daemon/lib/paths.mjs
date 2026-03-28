import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tradingDir = path.resolve(__dirname, "..", "..");

export const paths = {
  tradingDir,
  policy: path.join(tradingDir, "policy.json"),
  state: path.join(tradingDir, "state.json"),
  signals: path.join(tradingDir, "signals.jsonl"),
  pauseFile: (name) => path.join(tradingDir, name),
};

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/** JSON.stringify tidak mendukung bigint (mis. detail curve di red flags). */
export function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

export function stringifyJson(obj, space) {
  return JSON.stringify(obj, jsonReplacer, space);
}

export function writeState(state) {
  fs.writeFileSync(paths.state, JSON.stringify(state, jsonReplacer, 2) + "\n", "utf8");
}

export function appendSignal(obj) {
  fs.appendFileSync(paths.signals, JSON.stringify(obj, jsonReplacer) + "\n", "utf8");
}
