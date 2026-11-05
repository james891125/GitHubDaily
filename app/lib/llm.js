// LLM 供應商抽象層：使用者自帶 API Key。
// - anthropic：使用官方 @anthropic-ai/sdk
// - openai：任何 OpenAI 相容的 /chat/completions 端點（OpenAI、DeepSeek、OpenRouter、Ollama、Gemini 相容模式…）
import Anthropic from "@anthropic-ai/sdk";

export const CLAUDE_MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5（預設，最佳品質）" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5（速度與能力平衡）" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5（最快、最省）" },
];

// Haiku 5.5 沒有 server-side fallback；其他模型預設啟用
const SUPPORTS_FALLBACK = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5", "claude-fable-5-1"]);

export class LLMError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * 以串流方式產生文字。
 * @param {object} cfg  { provider, apiKey, model, baseUrl, effort }
 * @param {object} req  { system, prompt, maxTokens }
 * @param {(text:string)=>void} onText 每段文字增量
 * @returns {Promise<{text:string, model:string, usage?:object}>}
 */
export async function generate(cfg, req, onText = () => {}) {
  if (!cfg || !cfg.apiKey) {
    if (cfg?.provider === "openai" && cfg.baseUrl && /localhost|127\.0\.0\.1/.test(cfg.baseUrl)) {
      // 本機 Ollama 等可免金鑰
    } else {
      throw new LLMError("尚未設定 API Key，請先到「設定」頁輸入你的金鑰。", { status: 401 });
    }
  }
  if (cfg.provider === "openai") return generateOpenAI(cfg, req, onText);
  return generateClaude(cfg, req, onText);
}

async function generateClaude(cfg, { system, prompt, maxTokens = 32000 }, onText) {
  const client = new Anthropic({ apiKey: cfg.apiKey, ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}) });
  const model = cfg.model || "claude-opus-5-5";
  const params = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
    ...(system ? { system } : {}),
    ...(cfg.effort ? { output_config: { effort: cfg.effort } } : {}),
  };
  if (SUPPORTS_FALLBACK.has(model)) {
    // 安全分類器拒絕時，由伺服器端自動改用建議的備援模型重試
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }

  let text = "";
  try {
    const stream = SUPPORTS_FALLBACK.has(model)
      ? client.beta.messages.stream(params)
      : client.messages.stream(params);
    stream.on("text", (delta) => {
      text += delta;
      onText(delta);
    });
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      throw new LLMError("模型拒絕了這個請求（refusal）。請調整輸入內容後再試一次。", { status: 200 });
    }
    if (final.stop_reason === "max_tokens") {
      const note = "\n\n> ⚠️ 輸出已達 max_tokens 上限而被截斷。";
      text += note;
      onText(note);
    }
    return { text, model: final.model, usage: final.usage };
  } catch (err) {
    if (err instanceof LLMError) throw err;
    if (err instanceof Anthropic.AuthenticationError) {
      throw new LLMError("Claude API Key 無效或已過期（401）。", { status: 401 });
    }
    if (err instanceof Anthropic.PermissionDeniedError) {
      throw new LLMError("此 API Key 沒有使用該模型的權限（403）。", { status: 403 });
    }
    if (err instanceof Anthropic.NotFoundError) {
      throw new LLMError(`找不到模型「${model}」（404）。`, { status: 404 });
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new LLMError("已達速率限制（429），請稍後再試。", { status: 429, retryable: true });
    }
    if (err instanceof Anthropic.BadRequestError) {
      throw new LLMError(`請求格式錯誤（400）：${err.message}`, { status: 400 });
    }
    if (err instanceof Anthropic.APIConnectionError) {
      throw new LLMError("無法連線到 Claude API，請檢查網路。", { retryable: true });
    }
    if (err instanceof Anthropic.APIError) {
      throw new LLMError(`Claude API 錯誤（${err.status ?? "?"}）：${err.message}`, {
        status: err.status,
        retryable: (err.status ?? 0) >= 500,
      });
    }
    throw err;
  }
}

async function generateOpenAI(cfg, { system, prompt, maxTokens = 8000 }, onText) {
  const base = (cfg.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });
  // OpenAI 新模型（GPT-5、o 系列）只接受 max_completion_tokens，其他相容服務多用 max_tokens；
  // 被回「不支援此參數」時自動換另一個重試
  const send = (param) =>
    fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: cfg.model || "gpt-4o-mini", messages, stream: true, [param]: Math.max(maxTokens, 16000) }),
    });
  let param = /api\.openai\.com/.test(base) ? "max_completion_tokens" : "max_tokens";
  let res = await send(param);
  if (res.status === 400) {
    const errText = await res.clone().text().catch(() => "");
    if (/unsupported|not supported|unrecognized|unknown|extra/i.test(errText) && errText.includes(param)) {
      param = param === "max_tokens" ? "max_completion_tokens" : "max_tokens";
      res = await send(param);
    }
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new LLMError(`OpenAI 相容端點錯誤（${res.status}）：${body.slice(0, 300)}`, {
      status: res.status,
      retryable: res.status === 429 || res.status >= 500,
    });
  }
  let text = "";
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          onText(delta);
        }
      } catch {
        /* 忽略無法解析的片段 */
      }
    }
  }
  return { text, model: cfg.model };
}

/** 從模型輸出中擷取第一段 JSON（容許 ```json 區塊）。 */
export function extractJson(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start < 0) return null;
  const open = candidate[start];
  const close = open === "[" ? "]" : "}";
  const end = candidate.lastIndexOf(close);
  if (end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}
