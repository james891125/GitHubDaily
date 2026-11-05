// 本機 JSON 檔案儲存：所有資料都放在 studio/data/（已加入 .gitignore）
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.STUDIO_DATA_DIR || path.resolve(here, "..", "data");
export const OUTPUT_DIR = path.join(DATA_DIR, "outputs");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

export const newId = () => crypto.randomBytes(6).toString("hex");

function file(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

export function load(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), "utf8"));
  } catch {
    return fallback;
  }
}

export function save(name, value, { secret = false } = {}) {
  const f = file(name);
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: secret ? 0o600 : 0o644 });
  fs.renameSync(tmp, f);
}

export function remove(name) {
  fs.rmSync(file(name), { force: true });
}

/** 將產出檔案寫到 outputs/，回傳可下載的資訊 */
export function writeOutput(filename, data) {
  const safe = filename.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 120);
  const name = `${Date.now()}_${safe}`;
  fs.writeFileSync(path.join(OUTPUT_DIR, name), data);
  return { name, url: `/api/outputs/${encodeURIComponent(name)}`, size: Buffer.byteLength(data) };
}

export function listOutputs() {
  return fs
    .readdirSync(OUTPUT_DIR)
    .map((name) => {
      const st = fs.statSync(path.join(OUTPUT_DIR, name));
      return { name, url: `/api/outputs/${encodeURIComponent(name)}`, size: st.size, at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

export function outputPath(name) {
  const p = path.resolve(OUTPUT_DIR, name);
  if (!p.startsWith(OUTPUT_DIR + path.sep)) return null;
  return fs.existsSync(p) ? p : null;
}

// ---- 設定（含金鑰，只存在本機，檔案權限 600）----
const DEFAULT_SETTINGS = {
  provider: "anthropic",
  anthropicKey: "",
  claudeModel: "claude-opus-5-5",
  effort: "",
  openaiKey: "",
  openaiBase: "https://api.openai.com/v1",
  openaiModel: "gpt-4o-mini",
  embedModel: "",
  webhookUrl: "",
};

export function getSettings() {
  return {
    ...DEFAULT_SETTINGS,
    ...load("settings", {}),
    ...(process.env.ANTHROPIC_API_KEY && !load("settings", {}).anthropicKey ? { anthropicKey: process.env.ANTHROPIC_API_KEY } : {}),
  };
}

export function saveSettings(patch) {
  const cur = load("settings", {});
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    // 前端傳回遮罩過的金鑰代表「不變更」
    if (/Key$/.test(k) && typeof v === "string" && v.includes("•")) continue;
    next[k] = v;
  }
  save("settings", next, { secret: true });
  return getSettings();
}

const mask = (k) => (k ? `${k.slice(0, 6)}••••${k.slice(-4)}` : "");
export function publicSettings() {
  const s = getSettings();
  return { ...s, anthropicKey: mask(s.anthropicKey), openaiKey: mask(s.openaiKey) };
}
