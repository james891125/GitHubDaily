// LLM 呼叫層：Anthropic Claude（官方 SDK）或任何 OpenAI 相容端點
import Anthropic from "@anthropic-ai/sdk";
import { getSettings } from "./store.js";

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

function isLocal(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(url || "");
}

export function llmReady(s = getSettings()) {
  if (s.provider === "openai") return !!s.openaiKey || isLocal(s.openaiBase);
  return !!s.anthropicKey;
}

/**
 * 產生文字（串流）。
 * @param {{system?:string, prompt?:string, messages?:Array, maxTokens?:number, model?:string}} req
 * @param {(delta:string)=>void} [onText]
 * @param {AbortSignal} [signal]
 */
export async function generate(req, onText = () => {}, signal) {
  const s = getSettings();
  if (!llmReady(s)) throw new LLMError("尚未設定 API Key，請先到「設定」頁輸入你的金鑰。", 401);
  const messages = req.messages || [{ role: "user", content: req.prompt }];
  if (s.provider === "openai") return openaiChat(s, { ...req, messages }, onText, signal);
  return claudeChat(s, { ...req, messages }, onText, signal);
}

async function claudeChat(s, { system, messages, maxTokens = 32000, model }, onText, signal) {
  const client = new Anthropic({ apiKey: s.anthropicKey });
  const m = model || s.claudeModel || "claude-opus-5-5";
  const params = {
    model: m,
    max_tokens: maxTokens,
    messages,
    ...(system ? { system } : {}),
    ...(s.effort ? { output_config: { effort: s.effort } } : {}),
  };
  const useFallback = FALLBACK_MODELS.has(m);
  if (useFallback) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  let text = "";
  try {
    const stream = useFallback ? client.beta.messages.stream(params, { signal }) : client.messages.stream(params, { signal });
    stream.on("text", (d) => {
      text += d;
      onText(d);
    });
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") throw new LLMError("模型拒絕了此請求，請調整內容後重試。", 200);
    if (final.stop_reason === "max_tokens") {
      const note = "\n\n> ⚠️ 輸出達到長度上限而被截斷。";
      text += note;
      onText(note);
    }
    return { text, model: final.model, usage: final.usage };
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

async function openaiChat(s, { system, messages, maxTokens = 8000, model }, onText, signal) {
  const base = (s.openaiBase || "https://api.openai.com/v1").replace(/\/+$/, "");
  const msgs = system ? [{ role: "system", content: system }, ...messages] : messages;
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", ...(s.openaiKey ? { authorization: `Bearer ${s.openaiKey}` } : {}) },
    body: JSON.stringify({ model: model || s.openaiModel, messages: msgs, stream: true, max_tokens: maxTokens }),
  });
  if (!res.ok) throw new LLMError(`API 錯誤（${res.status}）：${(await res.text().catch(() => "")).slice(0, 300)}`, res.status);
  let text = "";
  let buf = "";
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
      try {
        const d = JSON.parse(line.slice(5)).choices?.[0]?.delta?.content;
        if (d) {
          text += d;
          onText(d);
        }
      } catch {
        /* skip */
      }
    }
  }
  return { text, model: model || s.openaiModel };
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

/** 要求 JSON 輸出，失敗時重試一次 */
export async function generateJson(prompt, { system, maxTokens = 16000, signal } = {}) {
  const sys = (system ? system + "\n" : "") + "只輸出合法的 JSON，不要加任何說明文字。";
  let { text } = await generate({ system: sys, prompt, maxTokens }, undefined, signal);
  let data = extractJson(text);
  if (data === null) {
    ({ text } = await generate(
      { system: sys, messages: [{ role: "user", content: prompt }, { role: "assistant", content: text }, { role: "user", content: "上面的輸出不是合法 JSON，請只輸出 JSON。" }], maxTokens },
      undefined,
      signal,
    ));
    data = extractJson(text);
  }
  if (data === null) throw new LLMError("AI 回傳的內容無法解析為 JSON。", 422);
  return data;
}
