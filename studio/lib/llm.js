// LLM 呼叫層：Anthropic Claude（官方 SDK）或任何 OpenAI 相容端點
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import Anthropic from "@anthropic-ai/sdk";
import { getSettings, load, save, DATA_DIR } from "./store.js";
import { PROVIDERS, chatConfig, providerReady, providerBase, providerHeaders } from "./providers.js";

export const CLAUDE_MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5（最佳品質，預設）" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5（速度與品質平衡）" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5（最快、最便宜）" },
];
// Haiku 5.5 沒有伺服器端備援
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5", "claude-fable-5-1"]);

export class LLMError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function llmReady(s = getSettings()) {
  return providerReady(chatConfig(s).id, s);
}
export const isClaude = (s = getSettings()) => chatConfig(s).kind === "anthropic";

// ================= 用量控管 =================
// 1. 回應快取：同樣的請求（模型、提示、設定都相同）在有效期內直接使用上次結果，不再呼叫 API
// 2. 用量統計：每次呼叫記錄 token 數，可依「單次執行」與「每日」查看
// 3. 省用量模式：翻譯、擷取、逐項處理等機械性工作使用較低的思考深度（思考 token 也要計費）
const CACHE_DIR = path.join(DATA_DIR, "llm-cache");
fs.mkdirSync(CACHE_DIR, { recursive: true });
const usageScope = new AsyncLocalStorage();

/** 在 fn 執行期間統計所有 AI 呼叫，回傳 { result, usage } */
export async function withUsage(fn) {
  const tally = { calls: 0, cached: 0, inputTokens: 0, outputTokens: 0, speech: 0, images: 0, estimated: false };
  const parent = usageScope.getStore();
  try {
    const result = await usageScope.run(tally, fn);
    return { result, usage: tally };
  } finally {
    // 巢狀統計：內層的用量也要算進外層
    if (parent) for (const k of ["calls", "cached", "inputTokens", "outputTokens", "speech", "images"]) parent[k] += tally[k];
    if (parent && tally.estimated) parent.estimated = true;
  }
}
export function currentUsage() {
  return usageScope.getStore() || null;
}

/**
 * 記錄用量。kind：chat（預設，依 token 計）、speech（語音轉文字，依錄音長度計費）、image（圖片生成，依張數計費）
 */
export function recordUsage({ cached, input = 0, output = 0, estimated = false, kind = "chat", count = 1 }) {
  if (kind !== "chat") {
    const field = kind === "speech" ? "speech" : "images";
    const t2 = usageScope.getStore();
    if (t2) t2[field] += count;
    const day2 = new Date().toLocaleDateString("sv-SE");
    const all2 = load("usage", {});
    const d2 = (all2[day2] ||= { calls: 0, cached: 0, inputTokens: 0, outputTokens: 0 });
    d2[field] = (d2[field] || 0) + count;
    save("usage", all2);
    return;
  }
  const t = usageScope.getStore();
  if (t) {
    if (cached) t.cached++;
    else t.calls++;
    t.inputTokens += input;
    t.outputTokens += output;
    t.estimated ||= estimated;
  }
  const day = new Date().toLocaleDateString("sv-SE");
  const all = load("usage", {});
  const d = (all[day] ||= { calls: 0, cached: 0, inputTokens: 0, outputTokens: 0 });
  if (cached) d.cached++;
  else d.calls++;
  d.inputTokens += input;
  d.outputTokens += output;
  // 只保留最近 90 天
  const keys = Object.keys(all).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 90))) delete all[k];
  save("usage", all);
}

export function usageSummary() {
  const all = load("usage", {});
  const today = new Date().toLocaleDateString("sv-SE");
  const month = today.slice(0, 7);
  const sum = (filter) =>
    Object.entries(all)
      .filter(([k]) => filter(k))
      .reduce(
        (a, [, v]) => ({ calls: a.calls + v.calls, cached: a.cached + v.cached, inputTokens: a.inputTokens + v.inputTokens, outputTokens: a.outputTokens + v.outputTokens, speech: a.speech + (v.speech || 0), images: a.images + (v.images || 0) }),
        { calls: 0, cached: 0, inputTokens: 0, outputTokens: 0, speech: 0, images: 0 },
      );
  return { today: sum((k) => k === today), month: sum((k) => k.startsWith(month)), days: all };
}

const estimateTokens = (text) => {
  const s = String(text || "");
  const cjk = (s.match(/[\u3400-\u9fff\uac00-\ud7af\u3040-\u30ff]/g) || []).length;
  return Math.ceil(cjk * 1.1 + (s.length - cjk) / 4);
};

function cacheKey(s, req) {
  const c = chatConfig(s);
  const provider = `${c.id}|${c.base}|${req.model || c.model}|${c.kind === "anthropic" ? effortFor(s, req) : ""}`;
  return crypto.createHash("sha256").update(JSON.stringify([provider, req.system || "", req.messages, req.maxTokens || 0, req.schema || null])).digest("hex");
}

function readCache(key, days) {
  if (!days) return null;
  try {
    const f = path.join(CACHE_DIR, key + ".json");
    const st = fs.statSync(f);
    if (Date.now() - st.mtimeMs > days * 86400000) return null;
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}
function writeCache(key, value) {
  try {
    fs.writeFileSync(path.join(CACHE_DIR, key + ".json"), JSON.stringify(value));
  } catch {
    /* 快取寫入失敗不影響結果 */
  }
}
export function clearCache() {
  let n = 0;
  for (const f of fs.readdirSync(CACHE_DIR)) {
    fs.rmSync(path.join(CACHE_DIR, f), { force: true });
    n++;
  }
  return n;
}

/** 決定思考深度：使用者有指定就用指定的；省用量模式下，機械性工作用 low */
function effortFor(s, req) {
  if (req.light && s.usageMode !== "quality") return "low";
  return s.effort || "";
}

/**
 * 產生文字（串流）。
 * @param {{system?:string, prompt?:string, messages?:Array, maxTokens?:number, model?:string,
 *          light?:boolean, schema?:object, noCache?:boolean}} req
 *   light：機械性工作（翻譯、擷取…），省用量模式下降低思考深度
 *   schema：要求 JSON 結構（Claude 會以結構化輸出保證格式，免去重試）
 * @param {(delta:string)=>void} [onText]
 * @param {AbortSignal} [signal]
 */
export async function generate(req, onText = () => {}, signal) {
  const s = getSettings();
  const cfg = chatConfig(s);
  if (!llmReady(s)) throw new LLMError(`尚未設定 ${cfg.name} 的 API Key，請先到「系統設定」輸入金鑰。`, 401);
  if (!cfg.model && !req.model) throw new LLMError(`尚未選擇 ${cfg.name} 的模型，請到「系統設定」按「取得模型清單」選擇。`, 400);
  let messages = req.messages || [{ role: "user", content: req.prompt }];
  if (req.attachments?.length) messages = withAttachments(messages, req.attachments, cfg);
  if (req.webSearch && cfg.kind !== "anthropic") throw new LLMError("「網路搜尋」功能需要使用 Claude（請到系統設定切換供應商）。", 400);
  const full = { ...req, messages };
  const days = req.noCache ? 0 : Number(s.cacheDays ?? 7);
  const key = cacheKey(s, full);
  const hit = readCache(key, days);
  if (hit) {
    onText(hit.text);
    recordUsage({ cached: true });
    return { ...hit, cached: true };
  }
  const r = cfg.kind === "anthropic" ? await claudeChat(s, full, onText, signal) : await openaiChat(s, cfg, full, onText, signal);
  recordUsage({ input: r.inputTokens, output: r.outputTokens, estimated: r.estimated });
  // 只有開啟快取時才寫入；被截斷的回應不快取
  if (days && !r.truncated) writeCache(key, { text: r.text, model: r.model, ...(r.sources ? { sources: r.sources } : {}) });
  return r;
}

/**
 * 把附件（PDF、圖片）放進最後一則使用者訊息。
 * attachments: [{ kind: "pdf" | "image", mediaType, data(base64), name }]
 */
function withAttachments(messages, attachments, cfg) {
  const last = messages.at(-1);
  const text = typeof last.content === "string" ? last.content : "";
  let content;
  if (cfg.kind !== "anthropic") {
    if (attachments.some((a) => a.kind === "pdf") && !cfg.can.pdf)
      throw new LLMError(`${cfg.name} 無法直接讀取 PDF。掃描型 PDF 請改用 Claude、OpenAI 或 OpenRouter；或將頁面截圖成圖片後再辨識。`, 400);
    if (attachments.some((a) => a.kind === "image") && !cfg.can.image) throw new LLMError(`${cfg.name} 的模型不支援圖片，請改用 Claude、OpenAI、Gemini 或 OpenRouter。`, 400);
    content = [
      { type: "text", text },
      ...attachments.map((a) =>
        a.kind === "pdf"
          ? { type: "file", file: { filename: a.name || "document.pdf", file_data: `data:application/pdf;base64,${a.data}` } }
          : { type: "image_url", image_url: { url: `data:${a.mediaType};base64,${a.data}` } },
      ),
    ];
  } else {
    content = [
      ...attachments.map((a) =>
        a.kind === "pdf"
          ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: a.data }, ...(a.name ? { title: a.name } : {}) }
          : { type: "image", source: { type: "base64", media_type: a.mediaType, data: a.data } },
      ),
      { type: "text", text },
    ];
  }
  return [...messages.slice(0, -1), { ...last, content }];
}

async function claudeChat(s, { system, messages, maxTokens = 32000, model, schema, webSearch, ...req }, onText, signal) {
  const client = new Anthropic({ apiKey: s.anthropicKey, ...(process.env.PROVIDER_BASE_ANTHROPIC ? { baseURL: process.env.PROVIDER_BASE_ANTHROPIC } : {}) });
  const m = model || s.claudeModel || "claude-opus-5-5";
  const effort = effortFor(s, req);
  const output_config = {
    ...(effort ? { effort } : {}),
    ...(schema ? { format: { type: "json_schema", schema } } : {}),
  };
  const params = {
    model: m,
    max_tokens: maxTokens,
    messages,
    ...(system ? { system } : {}),
    ...(Object.keys(output_config).length ? { output_config } : {}),
    ...(webSearch ? { tools: [{ type: "web_search_20260209", name: "web_search", max_uses: webSearch.maxUses || 5 }] } : {}),
  };
  const useFallback = FALLBACK_MODELS.has(m);
  if (useFallback) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  let text = "";
  const sources = [];
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    let final;
    // 使用網路搜尋時，伺服器端迴圈可能以 pause_turn 暫停，需把目前內容送回讓它繼續（最多 4 次）
    for (let round = 0; round < 5; round++) {
      const stream = useFallback ? client.beta.messages.stream(params, { signal }) : client.messages.stream(params, { signal });
      stream.on("text", (d) => {
        text += d;
        onText(d);
      });
      final = await stream.finalMessage();
      const u = final.usage || {};
      inputTokens += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      outputTokens += u.output_tokens || 0;
      for (const b of final.content || []) {
        if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
          for (const r of b.content) if (r.url && !sources.some((x) => x.url === r.url)) sources.push({ title: r.title || r.url, url: r.url });
        }
      }
      if (final.stop_reason !== "pause_turn") break;
      params.messages = [...params.messages, { role: "assistant", content: final.content }];
    }
    if (final.stop_reason === "refusal") throw new LLMError("模型拒絕了此請求，請調整內容後重試。", 200);
    let truncated = false;
    if (final.stop_reason === "max_tokens") {
      truncated = true;
      const note = "\n\n> 注意：輸出達到長度上限而被截斷。";
      text += note;
      onText(note);
    }
    return { text, model: final.model, truncated, inputTokens, outputTokens, ...(sources.length ? { sources } : {}) };
  } catch (e) {
    if (e instanceof LLMError) throw e;
    if (e instanceof Anthropic.AuthenticationError) throw new LLMError("Claude API Key 無效（401）。", 401);
    if (e instanceof Anthropic.PermissionDeniedError) throw new LLMError("此金鑰無權使用該模型（403）。", 403);
    if (e instanceof Anthropic.NotFoundError) throw new LLMError(`找不到模型 ${m}（404）。`, 404);
    if (e instanceof Anthropic.RateLimitError) throw new LLMError("已達速率限制（429），請稍後再試。", 429);
    if (e instanceof Anthropic.BadRequestError) throw new LLMError(`請求錯誤（400）：${e.message}`, 400);
    if (e instanceof Anthropic.APIConnectionError) throw new LLMError("無法連線到 Claude API。", 503);
    if (e instanceof Anthropic.APIError) throw new LLMError(`Claude API 錯誤（${e.status ?? "?"}）：${e.message}`, e.status);
    throw e;
  }
}

// 記住每個端點＋模型該用哪個長度參數，避免每次都先失敗一次
const tokenParamCache = new Map();

/**
 * 送出 chat/completions。輸出長度參數有兩種名稱：
 * - max_completion_tokens：OpenAI 新模型（GPT-5、o 系列等推理模型）只接受這個
 * - max_tokens：DeepSeek、Ollama、OpenRouter 等多數相容服務使用這個
 * 先依端點猜一個，若被回「不支援此參數」就自動換另一個重試。
 */
export async function postChatCompletion({ base, key, model, messages, maxTokens, signal, headers = {} }) {
  const official = /api\.openai\.com/.test(base);
  const cacheKey = `${base}|${model}`;
  const first = tokenParamCache.get(cacheKey) || (/api\.openai\.com/.test(base) ? "max_completion_tokens" : "max_tokens");
  const send = (param) =>
    fetch(`${base}/chat/completions`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
      body: JSON.stringify({ model, messages, stream: true, [param]: maxTokens, ...(official ? { stream_options: { include_usage: true } } : {}) }),
    });
  let param = first;
  let res = await send(param);
  if (res.status === 400) {
    const errText = await res.text().catch(() => "");
    const other = param === "max_tokens" ? "max_completion_tokens" : "max_tokens";
    if (/unsupported|not supported|unrecognized|unknown|extra/i.test(errText) && errText.includes(param)) {
      param = other;
      res = await send(param);
    } else {
      throw new LLMError(`API 錯誤（400）：${errText.slice(0, 300)}`, 400);
    }
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    const friendly = {
      401: "API Key 無效或未填寫（401）",
      403: "此 API Key 沒有權限使用這個模型（403）",
      404: `找不到模型「${model}」或 Base URL 錯誤（404）`,
      429: "已達速率限制或額度用完（429），請稍後再試或檢查帳戶餘額",
    }[res.status];
    throw new LLMError(friendly ? `${friendly}。伺服器訊息：${detail}` : `API 錯誤（${res.status}）：${detail}`, res.status);
  }
  tokenParamCache.set(cacheKey, param);
  return res;
}

async function openaiChat(s, cfg, { system, messages, maxTokens = 16000, model, schema }, onText, signal) {
  const msgs = system ? [{ role: "system", content: system }, ...messages] : messages;
  // 推理模型的思考也算在長度上限內，所以預設給大一點
  const res = await postChatCompletion({ base: cfg.base, key: cfg.key, model: model || cfg.model, messages: msgs, maxTokens, signal, headers: PROVIDERS[cfg.id]?.headers });
  let text = "";
  let buf = "";
  let usage = null;
  let finish = null;
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
      try {
        const j = JSON.parse(line.slice(5));
        if (j.usage) usage = j.usage;
        const c = j.choices?.[0];
        if (c?.finish_reason) finish = c.finish_reason;
        const d = c?.delta?.content;
        if (d) {
          text += d;
          onText(d);
        }
      } catch {
        /* skip */
      }
    }
  }
  const truncated = finish === "length";
  if (truncated) {
    const note = "\n\n> 注意：輸出達到長度上限而被截斷。";
    text += note;
    onText(note);
  }
  void schema;
  return {
    text,
    model: model || cfg.model,
    truncated,
    inputTokens: usage?.prompt_tokens ?? estimateTokens(msgs.map((m) => (typeof m.content === "string" ? m.content : (m.content || []).map((c) => c.text || "").join(" "))).join("\n")) + msgs.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter((c) => c.type === "image_url").length * 1000 : 0), 0),
    outputTokens: usage?.completion_tokens ?? estimateTokens(text),
    estimated: !usage,
  };
}

/** 擷取模型輸出中的 JSON（容許 ```json 區塊與前後說明文字） */
export function extractJson(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const c = fenced ? fenced[1] : text;
  const start = c.search(/[[{]/);
  if (start < 0) return null;
  const end = c.lastIndexOf(c[start] === "[" ? "]" : "}");
  if (end <= start) return null;
  try {
    return JSON.parse(c.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 要求 JSON 輸出。
 * - Claude：以結構化輸出（json_schema）保證格式，不需重試
 * - 其他：以提示要求 JSON，解析失敗才重試一次
 */
export async function generateJson(prompt, { system, maxTokens = 16000, signal, schema, light = true } = {}) {
  const s = getSettings();
  const sys = (system ? system + "\n" : "") + "只輸出合法的 JSON，不要加任何說明文字。";
  const useSchema = schema && chatConfig(s).kind === "anthropic";
  let { text } = await generate({ system: sys, prompt, maxTokens, light, ...(useSchema ? { schema } : {}) }, undefined, signal);
  let data = extractJson(text);
  if (data === null && !useSchema) {
    ({ text } = await generate(
      { system: sys, messages: [{ role: "user", content: prompt }, { role: "assistant", content: text }, { role: "user", content: "上面的輸出不是合法 JSON，請只輸出 JSON。" }], maxTokens, light },
      undefined,
      signal,
    ));
    data = extractJson(text);
  }
  if (data === null) throw new LLMError("AI 回傳的內容不是正確的 JSON 格式，請再試一次或換一個模型。", 422);
  return data;
}
