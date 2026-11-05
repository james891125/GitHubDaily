// 模型清單、語音轉文字、圖片生成
import Anthropic from "@anthropic-ai/sdk";
import { getSettings } from "./store.js";
import { PROVIDERS, providerBase, providerKey, providerHeaders, providerReady } from "./providers.js";
import { recordUsage, LLMError } from "./llm.js";
import { convertChinese } from "./tools.js";

const fail = (msg, status = 400) => new LLMError(msg, status);

async function compatFetch(id, s, path, init = {}, signal) {
  const base = providerBase(id, s);
  if (!base) throw fail(`尚未設定 ${PROVIDERS[id].name} 的服務網址`);
  let res;
  try {
    res = await fetch(base + path, { ...init, signal, headers: { ...providerHeaders(id, s), ...(init.headers || {}) } });
  } catch (e) {
    throw fail(`無法連線到 ${PROVIDERS[id].name}（${e.cause?.code || e.message}）${id === "ollama" ? "，請確認 Ollama 已啟動" : ""}`, 503);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    const friendly = { 401: "API Key 無效", 403: "沒有權限", 404: "找不到（模型名稱或網址錯誤）", 413: "檔案太大", 429: "已達速率限制或額度用完" }[res.status];
    throw fail(`${PROVIDERS[id].name}：${friendly || "錯誤"}（${res.status}）。${detail}`, res.status);
  }
  return res;
}

// ================= 模型清單 =================
const NOT_CHAT = /embed|tts|whisper|transcri|dall-e|imagen|moderation|realtime|audio-preview|search-preview|image-|rerank|guard/i;

/**
 * 從供應商 API 取得模型清單。
 * purpose：chat（文字）、speech（語音轉文字）、image（圖片生成）
 * @returns {Promise<Array<{id, name, context, input, output, price}>>}
 */
export async function listModels(id, { purpose = "chat", signal } = {}) {
  const s = getSettings();
  const p = PROVIDERS[id];
  if (!p) throw fail("未知的供應商");
  if (!providerReady(id, s)) throw fail(`請先填寫 ${p.name} 的 API Key${p.baseField ? "與服務網址" : ""}`);
  let models = [];
  if (p.kind === "anthropic") {
    const client = new Anthropic({ apiKey: s.anthropicKey, ...(process.env.PROVIDER_BASE_ANTHROPIC ? { baseURL: process.env.PROVIDER_BASE_ANTHROPIC } : {}) });
    try {
      for await (const m of client.models.list({ limit: 100 })) models.push({ id: m.id, name: m.display_name || m.id, context: m.max_input_tokens || null, input: ["text", "image", "pdf"], output: ["text"] });
    } catch (e) {
      throw fail(e.status === 401 ? "Claude API Key 無效" : `無法取得 Claude 模型清單：${e.message}`, e.status);
    }
  } else {
    const res = await compatFetch(id, s, "/models", {}, signal);
    const data = await res.json();
    const list = Array.isArray(data) ? data : data.data || data.models || [];
    models = list.map((m) => {
      const mid = String(m.id || m.name || "").replace(/^models\//, "");
      const per = (v) => (v == null || v === "" ? null : Math.round(Number(v) * 1e6 * 1000) / 1000);
      return {
        id: mid,
        name: m.name && m.name !== m.id ? String(m.name).replace(/^models\//, "") : m.display_name || mid,
        context: m.context_length || m.context_window || m.inputTokenLimit || null,
        input: m.architecture?.input_modalities || null,
        output: m.architecture?.output_modalities || null,
        price: m.pricing ? { input: per(m.pricing.prompt), output: per(m.pricing.completion) } : null,
      };
    });
  }
  const want = {
    // 會輸出圖片的是生圖模型（雖然也能輸出文字），不列入文字模型
    chat: (m) => (m.output ? m.output.includes("text") && !m.output.includes("image") : !NOT_CHAT.test(m.id)),
    speech: (m) => /whisper|transcri/i.test(m.id) || (m.input?.includes("audio") && m.output?.includes("text")),
    image: (m) => /dall-e|gpt-image|imagen|flux|stable-diffusion|sdxl|image-generation/i.test(m.id) || m.output?.includes("image"),
  }[purpose];
  return models.filter(want).sort((a, b) => a.id.localeCompare(b.id));
}

// ================= 語音轉文字 =================
export const AUDIO_TYPES = { ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".webm": "audio/webm", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".flac": "audio/flac", ".mp4": "video/mp4", ".mpga": "audio/mpeg", ".mpeg": "audio/mpeg", ".aac": "audio/aac" };

/** 選出語音轉文字要用的供應商：設定中指定的，否則用文字 AI 供應商（若支援） */
export function speechConfig(s = getSettings()) {
  let id = s.speechProvider;
  if (!id) {
    const chat = PROVIDERS[s.provider];
    if (chat?.can.speech || chat?.can.audioInput) id = s.provider;
  }
  if (!id || !PROVIDERS[id]) throw fail("尚未設定「語音轉文字」服務：請到系統設定選擇（OpenAI、Groq、Gemini 或 OpenRouter）。Claude 無法直接處理音檔。");
  const p = PROVIDERS[id];
  if (!p.can.speech && !p.can.audioInput) throw fail(`${p.name} 不支援語音轉文字`);
  if (!providerReady(id, s)) throw fail(`語音轉文字使用 ${p.name}，請先填寫它的 API Key`);
  const model = s.speechModel || p.speechModels?.[0] || (id === s.provider ? s[p.modelField] : "") || "";
  if (!model) throw fail(`請到系統設定選擇 ${p.name} 的語音轉文字模型`);
  return { id, p, model, mode: p.can.speech ? "transcriptions" : "chat" };
}

const LANG = { "zh-TW": "zh", zh: "zh", en: "en", ja: "ja", ko: "ko", auto: "" };

/**
 * @param {Buffer} buf
 * @param {{ name: string, language?: "zh-TW"|"en"|"ja"|"ko"|"auto", prompt?: string, signal?: AbortSignal }} opts
 * @returns {Promise<{ text: string, segments?: Array<{start,end,text}>, provider: string, model: string }>}
 */
export async function transcribe(buf, { name, language = "zh-TW", prompt = "", signal } = {}) {
  const s = getSettings();
  const { id, p, model, mode } = speechConfig(s);
  const ext = (name.match(/\.[^.]+$/)?.[0] || "").toLowerCase();
  const limit = 25 * 1024 * 1024;
  if (buf.length > limit) throw fail(`音檔 ${(buf.length / 1048576).toFixed(1)} MB，超過 25 MB 上限。請轉成較低位元率的 MP3（例如 64 kbps，約可容納 50 分鐘），或分段上傳。`, 413);
  const lang = LANG[language] ?? "";
  let text = "";
  let segments;
  if (mode === "transcriptions") {
    const form = new FormData();
    form.append("file", new Blob([buf], { type: AUDIO_TYPES[ext] || "application/octet-stream" }), name.replace(/[^\x20-\x7e]/g, "_") || "audio" + ext);
    form.append("model", model);
    const verbose = /whisper/i.test(model);
    form.append("response_format", verbose ? "verbose_json" : "json");
    if (lang) form.append("language", lang);
    // 提示可引導用字（例如繁體中文、專有名詞）
    const hint = [language === "zh-TW" ? "以下是繁體中文的逐字稿，請使用臺灣用語與全形標點。" : "", prompt].filter(Boolean).join(" ");
    if (hint) form.append("prompt", hint.slice(0, 800));
    const res = await compatFetch(id, s, "/audio/transcriptions", { method: "POST", body: form }, signal);
    const data = await res.json();
    text = data.text || "";
    if (Array.isArray(data.segments)) segments = data.segments.map((g) => ({ start: g.start, end: g.end, text: String(g.text || "").trim() }));
  } else {
    const fmt = { ".mp3": "mp3", ".mpga": "mp3", ".mpeg": "mp3", ".wav": "wav" }[ext];
    if (!fmt) throw fail(`${p.name} 只接受 MP3 或 WAV 音檔，請先轉檔（或改用 OpenAI／Groq 的語音轉文字）`, 422);
    const instruction = `請將這段錄音逐字轉成文字${language === "zh-TW" ? "（使用繁體中文與臺灣用語）" : ""}，不要摘要、不要加入說明，只輸出逐字稿。${prompt}`;
    const res = await compatFetch(
      id,
      s,
      "/chat/completions",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: [{ type: "text", text: instruction }, { type: "input_audio", input_audio: { data: buf.toString("base64"), format: fmt } }] }] }) },
      signal,
    );
    const data = await res.json();
    text = data.choices?.[0]?.message?.content || "";
  }
  // Whisper 常輸出簡體字：選擇繁體中文時在本機轉成臺灣用語
  if (language === "zh-TW") {
    text = convertChinese(text, "s2twp");
    segments = segments?.map((g) => ({ ...g, text: convertChinese(g.text, "s2twp") }));
  }
  recordUsage({ kind: "speech" });
  if (!text.trim()) throw fail("沒有辨識到任何語音內容（可能是靜音或音質太差）", 422);
  return { text: text.trim(), segments, provider: p.name, model };
}

const ts = (sec, sep = ",") => {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s2 = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s2).padStart(2, "0")}${sep}${String(ms % 1000).padStart(3, "0")}`;
};
export function toSrt(segments) {
  return segments.map((g, i) => `${i + 1}\n${ts(g.start)} --> ${ts(g.end)}\n${g.text}\n`).join("\n");
}
export function toVtt(segments) {
  return "WEBVTT\n\n" + segments.map((g) => `${ts(g.start, ".")} --> ${ts(g.end, ".")}\n${g.text}\n`).join("\n");
}
/** 加上時間標記的逐字稿（每段一行） */
export function toTimestamped(segments) {
  return segments.map((g) => `[${ts(g.start).slice(0, 8)}] ${g.text}`).join("\n");
}

// ================= 圖片生成 =================
export function imageConfig(s = getSettings()) {
  let id = s.imageProvider;
  if (!id && PROVIDERS[s.provider]?.can.imageGen) id = s.provider;
  if (!id || !PROVIDERS[id]) throw fail("尚未設定「圖片生成」服務：請到系統設定選擇（OpenAI、Gemini 或 OpenRouter）。Claude 無法產生圖片。");
  const p = PROVIDERS[id];
  if (!p.can.imageGen) throw fail(`${p.name} 不支援圖片生成`);
  if (!providerReady(id, s)) throw fail(`圖片生成使用 ${p.name}，請先填寫它的 API Key`);
  const model = s.imageModel || p.imageModels?.[0] || "";
  if (!model) throw fail(`請到系統設定選擇 ${p.name} 的圖片生成模型`);
  return { id, p, model };
}

/**
 * @returns {Promise<Array<{ buf: Buffer, ext: string }>>}
 */
export async function generateImages(prompt, { size = "1024x1024", n = 1, signal } = {}) {
  const s = getSettings();
  const { id, model } = imageConfig(s);
  n = Math.min(Math.max(Number(n) || 1, 1), 4);
  const images = [];
  const fromDataUrl = (u) => {
    const m = /^data:image\/(\w+);base64,(.+)$/.exec(u || "");
    return m ? { buf: Buffer.from(m[2], "base64"), ext: m[1] === "jpeg" ? "jpg" : m[1] } : null;
  };
  if (id === "openrouter") {
    // OpenRouter 的圖片模型透過 chat/completions 產生圖片
    for (let i = 0; i < n; i++) {
      const res = await compatFetch(id, s, "/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], modalities: ["image", "text"] }) }, signal);
      const data = await res.json();
      for (const im of data.choices?.[0]?.message?.images || []) {
        const r = fromDataUrl(im.image_url?.url);
        if (r) images.push(r);
      }
    }
  } else {
    const body = { model, prompt, n, size };
    if (!/gpt-image/i.test(model)) body.response_format = "b64_json";
    const res = await compatFetch(id, s, "/images/generations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, signal);
    const data = await res.json();
    for (const d of data.data || []) {
      if (d.b64_json) images.push({ buf: Buffer.from(d.b64_json, "base64"), ext: "png" });
      else if (d.url) {
        const r = d.url.startsWith("data:") ? fromDataUrl(d.url) : { buf: Buffer.from(await (await fetch(d.url, { signal })).arrayBuffer()), ext: "png" };
        if (r) images.push(r);
      }
    }
  }
  recordUsage({ kind: "image", count: images.length });
  if (!images.length) throw fail("圖片生成服務沒有回傳圖片（可能是內容被安全規則擋下，請調整描述後再試）", 422);
  return images;
}
