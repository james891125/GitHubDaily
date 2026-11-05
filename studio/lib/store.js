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
  provider: "anthropic",
  anthropicKey: "",
  claudeModel: "claude-opus-5-5",
  effort: "",
  openaiKey: "",
  openaiBase: "https://api.openai.com/v1",
  openaiModel: "gpt-4o-mini",
  embedModel: "",
  webhookUrl: "",
  elsevierKey: "",
  elsevierInstToken: "",
  usageMode: "economy", // economy：機械性工作降低思考深度；quality：一律使用設定的思考深度
  cacheDays: 7, // AI 回應快取天數，0 = 不快取
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
    if (/(Key|Token)$/.test(k) && typeof v === "string" && v.includes("•")) continue;
    next[k] = v;
  }
  save("settings", next, { secret: true });
  return getSettings();
}

const mask = (k) => (k ? `${k.slice(0, 6)}••••${k.slice(-4)}` : "");
export function publicSettings() {
  const s = getSettings();
  return { ...s, anthropicKey: mask(s.anthropicKey), openaiKey: mask(s.openaiKey), elsevierKey: mask(s.elsevierKey), elsevierInstToken: mask(s.elsevierInstToken) };
}
