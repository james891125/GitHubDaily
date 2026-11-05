// AI 供應商登錄表：每家各自保存金鑰與模型，切換時不會遺失。
// 除 Anthropic 外皆使用 OpenAI 相容 API（/chat/completions、/models、/audio/transcriptions、/images/generations）。
// 測試或特殊網路環境可用環境變數覆寫網址，例如 PROVIDER_BASE_OPENROUTER=http://127.0.0.1:1234/v1

export const PROVIDERS = {
  anthropic: {
    name: "Anthropic Claude",
    kind: "anthropic",
    keyField: "anthropicKey",
    modelField: "claudeModel",
    defaultModel: "claude-opus-5-5",
    keyUrl: "https://console.anthropic.com/settings/keys",
    note: "功能最完整：可直接讀 PDF 與圖片、網路搜尋、結構化輸出。",
    can: { chat: true, pdf: true, image: true, webSearch: true },
  },
  openai: {
    name: "OpenAI",
    base: "https://api.openai.com/v1",
    keyField: "openaiKey",
    modelField: "openaiModel",
    keyUrl: "https://platform.openai.com/api-keys",
    note: "GPT 系列；另提供語音轉文字（Whisper、gpt-4o-transcribe）與圖片生成（gpt-image）。",
    can: { chat: true, pdf: true, image: true, speech: true, imageGen: true },
    speechModels: ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"],
    imageModels: ["gpt-image-1", "dall-e-3"],
  },
  openrouter: {
    name: "OpenRouter",
    base: "https://openrouter.ai/api/v1",
    keyField: "openrouterKey",
    modelField: "openrouterModel",
    keyUrl: "https://openrouter.ai/keys",
    note: "一把金鑰使用數百種模型（Claude、GPT、Gemini、Llama、DeepSeek…），模型清單會標示支援的輸入類型與價格。",
    can: { chat: true, pdf: true, image: true, audioInput: true, imageGen: true },
    headers: { "HTTP-Referer": "http://localhost", "X-Title": "AI Office Platform" },
  },
  gemini: {
    name: "Google Gemini",
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyField: "geminiKey",
    modelField: "geminiModel",
    keyUrl: "https://aistudio.google.com/apikey",
    note: "可直接聽音檔、看圖片；有免費額度。圖片生成使用 Imagen 模型。",
    can: { chat: true, image: true, audioInput: true, imageGen: true },
    imageModels: ["imagen-4.0-generate-001", "imagen-3.0-generate-002"],
  },
  deepseek: {
    name: "DeepSeek",
    base: "https://api.deepseek.com/v1",
    keyField: "deepseekKey",
    modelField: "deepseekModel",
    keyUrl: "https://platform.deepseek.com/api_keys",
    note: "價格低廉的文字模型（不支援圖片、音檔）。",
    can: { chat: true },
  },
  groq: {
    name: "Groq",
    base: "https://api.groq.com/openai/v1",
    keyField: "groqKey",
    modelField: "groqModel",
    keyUrl: "https://console.groq.com/keys",
    note: "速度極快；語音轉文字（whisper-large-v3）便宜又快，適合長錄音。",
    can: { chat: true, speech: true },
    speechModels: ["whisper-large-v3-turbo", "whisper-large-v3"],
  },
  ollama: {
    name: "Ollama（本機）",
    baseField: "ollamaBase",
    defaultBase: "http://localhost:11434/v1",
    modelField: "ollamaModel",
    noKey: true,
    keyUrl: "https://ollama.com/download",
    note: "在自己電腦執行開源模型，免費、資料不外流；需先安裝 Ollama 並下載模型。",
    can: { chat: true, image: true },
  },
  custom: {
    name: "其他 OpenAI 相容服務",
    baseField: "customBase",
    keyField: "customKey",
    modelField: "customModel",
    note: "任何提供 OpenAI 相容 API 的服務（例如學校自建的模型伺服器、vLLM、LM Studio、Azure 等）。",
    can: { chat: true, image: true, speech: true, imageGen: true },
  },
};

export function providerBase(id, s) {
  const p = PROVIDERS[id];
  if (!p) return "";
  const env = process.env[`PROVIDER_BASE_${id.toUpperCase()}`];
  if (env) return env.replace(/\/+$/, "");
  return String(p.baseField ? s[p.baseField] || p.defaultBase || "" : p.base).replace(/\/+$/, "");
}

export function providerKey(id, s) {
  const p = PROVIDERS[id];
  return p?.keyField ? s[p.keyField] || "" : "";
}

/** 這家供應商是否已可使用（有金鑰，或為免金鑰的本機服務） */
export function providerReady(id, s) {
  const p = PROVIDERS[id];
  if (!p) return false;
  if (p.noKey) return !!providerBase(id, s);
  if (id === "custom") return !!s.customBase && (!!s.customKey || /localhost|127\.0\.0\.1/.test(s.customBase));
  return !!providerKey(id, s);
}

export function providerHeaders(id, s) {
  const key = providerKey(id, s);
  return { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(PROVIDERS[id]?.headers || {}) };
}

/** 目前文字 AI 的連線資訊 */
export function chatConfig(s) {
  const id = PROVIDERS[s.provider] ? s.provider : "anthropic";
  const p = PROVIDERS[id];
  return {
    id,
    name: p.name,
    kind: p.kind || "compat",
    base: p.kind === "anthropic" ? "" : providerBase(id, s),
    key: providerKey(id, s),
    model: s[p.modelField] || p.defaultModel || "",
    headers: providerHeaders(id, s),
    can: p.can,
  };
}
