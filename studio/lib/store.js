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
  const data = JSON.stringify(value, null, 2);
  fs.writeFileSync(tmp, data, { mode: secret ? 0o600 : 0o644 });
  try {
    fs.renameSync(tmp, f);
  } catch {
    // Windows 上若檔案正被防毒軟體或其他程式開啟，改名可能失敗：改為直接覆寫
    fs.writeFileSync(f, data, { mode: secret ? 0o600 : 0o644 });
    fs.rmSync(tmp, { force: true });
  }
}

export function remove(name) {
  fs.rmSync(file(name), { force: true });
}

/** 將產出檔案寫到 outputs/，回傳可下載的資訊 */
export function safeFileName(filename, max = 100) {
  // 移除 Windows 不允許的字元與控制字元；保留副檔名；避免結尾為句點或空白
  const ext = (/\.[A-Za-z0-9]{1,6}$/.exec(filename) || [""])[0];
  let base = filename.slice(0, filename.length - ext.length).replace(/[\\/:*?"<>|\s\x00-\x1f]+/g, "_").replace(/[. ]+$/, "");
  // macOS / Linux 的檔名上限是 255「位元組」，中文每字 3 位元組，所以依位元組數截斷（含時間戳前綴仍有餘裕）
  const chars = [...base].slice(0, max);
  while (chars.length && Buffer.byteLength(chars.join("")) > 200) chars.pop();
  base = chars.join("").replace(/[. ]+$/, "") || "output";
  return base + ext.toLowerCase();
}

export function writeOutput(filename, data) {
  const name = `${Date.now()}_${safeFileName(filename)}`;
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
  provider: "anthropic", // 文字 AI 供應商：anthropic、openai、openrouter、gemini、deepseek、groq、ollama、custom
  anthropicKey: "",
  claudeModel: "claude-opus-5-5",
  effort: "",
  openaiKey: "",
  openaiModel: "",
  openrouterKey: "",
  openrouterModel: "",
  geminiKey: "",
  geminiModel: "",
  deepseekKey: "",
  deepseekModel: "",
  groqKey: "",
  groqModel: "",
  ollamaBase: "http://localhost:11434/v1",
  ollamaModel: "",
  customBase: "",
  customKey: "",
  customModel: "",
  speechProvider: "", // 語音轉文字：openai、groq、gemini、openrouter、custom
  speechModel: "",
  imageProvider: "", // 圖片生成：openai、gemini、openrouter、custom
  imageModel: "",
  webhookUrl: "",
  elsevierKey: "",
  elsevierInstToken: "",
  usageMode: "economy", // economy：機械性工作降低思考深度；quality：一律使用設定的思考深度
  cacheDays: 7, // AI 回應快取天數，0 = 不快取
};
const SECRET = /(Key|Token)$/;
const OFFICIAL_OPENAI = /^https:\/\/api\.openai\.com\/v1\/?$/;

/** 舊版設定（provider: "openai" + openaiBase）轉換為新版 */
function migrate(raw) {
  const s = { ...raw };
  if (s.openaiBase !== undefined) {
    if (!OFFICIAL_OPENAI.test(s.openaiBase || "") && s.openaiBase) {
      s.customBase ||= s.openaiBase;
      s.customKey ||= s.openaiKey || "";
      s.customModel ||= s.openaiModel || "";
      if (s.provider === "openai") s.provider = "custom";
      s.openaiKey = s.openaiKey && s.customKey === s.openaiKey ? "" : s.openaiKey;
      s.openaiModel = s.openaiModel && s.customModel === s.openaiModel ? "" : s.openaiModel;
    }
    delete s.openaiBase;
  }
  return s;
}

export function getSettings() {
  const stored = migrate(load("settings", {}));
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    ...(process.env.ANTHROPIC_API_KEY && !stored.anthropicKey ? { anthropicKey: process.env.ANTHROPIC_API_KEY } : {}),
  };
}

export function saveSettings(patch = {}) {
  const cur = migrate(load("settings", {}));
  patch = { ...patch };
  // 相容舊版欄位（openaiBase / openaiKey / openaiModel）：
  // 網址不是 OpenAI 官方 → 屬於「其他 OpenAI 相容服務」(custom)
  const legacyBase = patch.openaiBase;
  delete patch.openaiBase;
  const targetProvider = patch.provider ?? cur.provider;
  // 只有舊版用戶端（送 openaiBase，或沒有送任何 custom 欄位）才套用轉換；新版設定頁會分別送出各家欄位
  const legacyClient = legacyBase !== undefined || !["customKey", "customModel", "customBase"].some((k) => k in patch);
  const toCustom = legacyClient && (legacyBase !== undefined ? !!legacyBase && !OFFICIAL_OPENAI.test(legacyBase) : targetProvider === "custom");
  if (toCustom) {
    if (legacyBase) patch.customBase = legacyBase;
    if ("openaiKey" in patch) patch.customKey = patch.openaiKey;
    if ("openaiModel" in patch) patch.customModel = patch.openaiModel;
    delete patch.openaiKey;
    delete patch.openaiModel;
    if (patch.provider === "openai") patch.provider = "custom";
  }
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    // 前端傳回遮罩過的金鑰代表「不變更」
    if (SECRET.test(k) && typeof v === "string" && v.includes("•")) continue;
    next[k] = typeof v === "string" ? v.trim() : v;
  }
  save("settings", next, { secret: true });
  return getSettings();
}

// 只顯示頭尾少量字元；太短的金鑰完全遮蔽
const mask = (k) => (!k ? "" : k.length < 16 ? "••••••••" : `${k.slice(0, 4)}••••${k.slice(-4)}`);
export function publicSettings() {
  const s = getSettings();
  const out = { ...s };
  for (const k of Object.keys(out)) if (SECRET.test(k)) out[k] = mask(out[k]);
  return out;
}
