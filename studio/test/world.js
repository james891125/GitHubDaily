// 「模擬世界」：用本機伺服器重現真實使用時會遇到的各種情況，讓範本可以完整測試
//  - 假網站：一般頁面、Big5 編碼、轉址、gzip、直接連到 PDF/Word、被擋(403)、JavaScript 才有內容的頁面、JSON API…
//  - 假 OpenAI 相容 API：一般 / 只收 max_completion_tokens（GPT-5 類）/ 推理模型空白片段 / 429 / 壞掉的 JSON
//  - 假 Claude API（Anthropic Messages SSE 格式）：記錄請求內容，可模擬拒絕(refusal)
//  - Webhook 接收器、學術 API（Elsevier / Crossref / OpenAlex）
import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs";
import { makePdf, startScholarMock } from "./fixtures.js";

const FILES = new URL("./files/", import.meta.url);

function listen(server) {
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
}

// ---------------- 假網站 ----------------
export async function startWorldSite() {
  let counter = 0;
  const html = (title, body, head = "") =>
    `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="${title}的說明"><meta name="viewport" content="width=device-width">${head}</head><body>${body}</body></html>`;
  const article = (t, p) => `<header><nav><a href="/">首頁</a> <a href="/about">關於</a></nav></header><main><article><h1>${t}</h1>${p}</article></main><footer>© 2026</footer>`;
  const longP = (s, n = 10) => `<p>${s.repeat(n)}</p>`;
  const big5 = (s) => {
    // 以 TextDecoder 反查建表，將中文轉成 Big5 位元組
    const dec = new TextDecoder("big5");
    const table = new Map();
    for (let hi = 0xa1; hi <= 0xf9; hi++)
      for (let lo = 0x40; lo <= 0xfe; lo++) {
        if (lo > 0x7e && lo < 0xa1) continue;
        const ch = dec.decode(Buffer.from([hi, lo]));
        if (ch.length === 1 && !table.has(ch)) table.set(ch, [hi, lo]);
      }
    const out = [];
    for (const ch of s) {
      if (ch.charCodeAt(0) < 128) out.push(ch.charCodeAt(0));
      else out.push(...(table.get(ch) || [0x3f]));
    }
    return Buffer.from(out);
  };

  const routes = {
    "/": () => html("測試商店", article("歡迎光臨", longP("本店販售各式手工茶葉，退貨期限為七天。", 12) + '<p><a href="/products">產品</a> <a href="/missing">壞掉的連結</a> <a href="https://other.example/">外站</a></p><img src="a.png">')),
    "/about": () => html("關於我們", article("關於", longP("我們成立於 2010 年，總部位於台北市信義區。客服電話 02-1234-5678。", 8))),
    "/products": () => html("產品", `<h1>產品列表</h1><table><tr><th>品名</th><th>價格</th></tr><tr><td>烏龍茶</td><td>350</td></tr><tr><td>紅茶</td><td>280</td></tr></table><a href="/">首頁</a>`),
    "/en": () => html("Tea Guide", article("A Guide to Oolong Tea", longP("Oolong tea is partially oxidized and originates from Taiwan and China. ", 15))),
    "/news/1": () => html("颱風假公告", article("颱風假公告", longP("台北市政府宣布明日停班停課，請民眾注意安全。", 6))),
    "/news/2": () => html("新品上市", article("新品上市", longP("本週推出冬季限定桂花烏龍，售價 420 元。", 6))),
    "/docs/": () => html("說明文件", article("說明文件首頁", longP("這是產品說明文件。", 8) + '<a href="/docs/install">安裝</a> <a href="/docs/faq">常見問題</a> <a href="/blog">部落格</a>')),
    "/docs/install": () => html("安裝", article("安裝步驟", longP("下載安裝檔後執行 setup.exe，依指示完成安裝。", 8))),
    "/docs/faq": () => html("常見問題", article("常見問題", longP("問：忘記密碼怎麼辦？答：點選登入頁的忘記密碼，系統會寄送重設信。", 6))),
    "/blog": () => html("部落格", article("部落格", longP("這是部落格文章，不屬於說明文件。", 8))),
    "/changing": () => html("價格", `<h1>價格</h1><p>目前價格 ${100 + counter++} 元</p>`),
    "/spa": () => `<!doctype html><html><head><title>React App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>`,
    "/sitemap.xml": () => ({ type: "application/xml", body: `<?xml version="1.0"?><urlset><url><loc>/</loc></url></urlset>` }),
  };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    const send = (code, body, type = "text/html; charset=utf-8", extra = {}) => {
      res.writeHead(code, { "content-type": type, ...extra });
      res.end(body);
    };
    if (p === "/robots.txt") return send(200, "User-agent: *\nAllow: /", "text/plain");
    if (p === "/rss.xml") {
      const d = (n) => new Date(Date.now() - n * 86400000).toUTCString();
      return send(200, `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>教育部新聞</title>
        <item><title>大專校院數位學習補助計畫公告</title><link>https://news.example/1</link><pubDate>${d(0)}</pubDate><description><![CDATA[<p>補助每校最高 <b>500 萬元</b>。</p>]]></description></item>
        <item><title>新學年度招生名額核定</title><link>https://news.example/2</link><pubDate>${d(1)}</pubDate><description>核定名額共 20 萬人。</description></item>
        <item><title>舊聞</title><link>https://news.example/3</link><pubDate>${d(30)}</pubDate><description>很久以前的消息。</description></item>
        </channel></rss>`, "application/rss+xml");
    }
    if (p === "/atom.xml") return send(200, `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>期刊目次</title><entry><title>Atom 期刊新文章</title><link href="https://journal.example/a"/><updated>${new Date().toISOString()}</updated><summary>摘要內容</summary></entry></feed>`, "application/atom+xml");
    if (p === "/redirect") return send(301, "", "text/html", { location: "/about" });
    if (p === "/blocked") return send(403, "<h1>Access Denied</h1>");
    if (p === "/ratelimited") return send(429, "Too Many Requests", "text/plain");
    if (p === "/server-error") return send(500, "Internal Server Error", "text/plain");
    if (p === "/big5") return send(200, big5(html("繁體中文公告", article("重要公告", "<p>本校圖書館將於十二月一日起延長開放時間至晚上十點。</p>"))), "text/html; charset=big5");
    if (p === "/big5-meta") {
      const page = `<html><head><meta http-equiv="Content-Type" content="text/html; charset=big5"><title>舊網站</title></head><body><h1>系統公告</h1><p>本系統於每週日凌晨進行維護，期間暫停服務。</p></body></html>`;
      return send(200, big5(page), "text/html");
    }
    if (p === "/gzip") return send(200, zlib.gzipSync(html("壓縮頁面", article("壓縮內容", "<p>這是經過 gzip 壓縮傳送的內容。</p>"))), "text/html; charset=utf-8", { "content-encoding": "gzip" });
    if (p === "/paper.pdf") return send(200, makePdf(["Deep learning for tea classification", "Accuracy reached 97 percent"]), "application/pdf");
    if (p === "/zh.pdf") return send(200, fs.readFileSync(new URL("中文報告.pdf", FILES)), "application/pdf");
    if (p === "/quote.docx") return send(200, fs.readFileSync(new URL("報價單.docx", FILES)), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    if (p === "/download") return send(200, makePdf(["Attachment download content"]), "application/octet-stream", { "content-disposition": 'attachment; filename="report.pdf"' });
    if (p === "/api/issues")
      return send(
        200,
        JSON.stringify([
          { number: 101, title: "登入頁在 Safari 上無法送出", html_url: "https://example.com/issues/101", labels: [{ name: "bug" }], comments: 12 },
          { number: 102, title: "希望支援深色模式", html_url: "https://example.com/issues/102", labels: [{ name: "enhancement" }], comments: 3 },
        ]),
        "application/json",
      );
    if (p === "/api/echo" && req.method === "POST") {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => send(200, JSON.stringify({ received: b, auth: req.headers.authorization || null }), "application/json"));
      return;
    }
    const r = routes[p];
    if (!r) return send(404, "<h1>404</h1>");
    const out = r();
    if (typeof out === "object") return send(200, out.body, out.type);
    send(200, out, "text/html; charset=utf-8", { "x-content-type-options": "nosniff", "set-cookie": "sid=1; Path=/" });
  });
  return { server, url: await listen(server) };
}

// ---------------- 共用的假 AI 回覆邏輯 ----------------
export function fakeAnswer(system, userText, { hasPdf = false, hasImage = false } = {}) {
  const all = `${system || ""}\n${userText}`;
  if (hasPdf || hasImage) return { text: `（${hasPdf ? "PDF" : "圖片"}文字辨識結果）\n\n# 掃描文件\n\n本校圖書館開放時間為上午八點至晚上十點。\n\n| 項目 | 時間 |\n|---|---|\n| 平日 | 08:00-22:00 |` };
  if (all.includes("REFUSE_ME")) return { refuse: true };
  if (all.includes('{"results":')) {
    const n = (userText.match(/<item id="/g) || []).length;
    const items = userText.split(/<item id="\d+">/).slice(1);
    return { text: JSON.stringify({ results: items.map((it, k) => `第${k + 1}項摘要：${it.replace(/\s+/g, " ").trim().slice(0, 30)}`) }).replace(/^/, n ? "" : "") };
  }
  if (all.includes('"columns"') && all.includes('[["值1"')) {
    if (/伺服器/.test(all)) return { text: '{"columns":["項目","數量","單價","金額","備註"],"rows":[["伺服器","2","45000","90000",""],["授權","10","1200","12000",""]]}' };
    if (/烏龍茶/.test(all)) return { text: '{"columns":["品名","價格"],"rows":[["烏龍茶","350"],["紅茶","280"]]}' };
    return { text: '{"columns":["名稱","數值"],"rows":[["範例","1"]]}' };
  }
  if (all.includes('"columns"')) {
    if (/價格|單價/.test(all) && /烏龍茶|伺服器/.test(all))
      return { text: /伺服器/.test(all) ? '{"columns":["項目","數量","單價","金額","備註"],"rows":[{"項目":"伺服器","數量":"2","單價":"45000","金額":"90000","備註":""},{"項目":"授權","數量":"10","單價":"1200","金額":"12000","備註":""}]}' : '```json\n{"columns":["品名","價格"],"rows":[{"品名":"烏龍茶","價格":"350"},{"品名":"紅茶","價格":"280"}]}\n```' };
    return { text: '{"columns":["名稱","數值"],"rows":[{"名稱":"範例","數值":"1"}]}' };
  }
  if (/只輸出合法的 JSON/.test(all)) return { text: '{"ok":true}' };
  if (all.includes("翻譯成")) {
    const src = userText.split("---\n").pop();
    return { text: "【譯文】" + src.replace(/\s+/g, " ").slice(0, 60) };
  }
  if (all.includes("參考資料")) {
    if (/退貨/.test(userText.split("問題：").pop()) && /七天/.test(all)) return { text: "退貨期限是七天 [1]。" };
    if (/密碼/.test(userText.split("問題：").pop()) && /忘記密碼/.test(all)) return { text: "點選登入頁的「忘記密碼」即可重設 [1]。" };
    return { text: "知識庫中沒有相關資訊。" };
  }
  if (all.includes("連線成功")) return { text: "連線成功" };
  // 其他：回傳可辨識的摘要，並帶出輸入的開頭，用來驗證資料有正確傳入
  const snippet = userText.replace(/[#>*`|\-\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  return { text: `## AI 回覆\n\n- 重點一\n- 重點二\n\n（收到 ${userText.length} 字：${snippet}）` };
}

// ---------------- 假 OpenAI 相容 API ----------------
// 依 model 名稱切換行為：mock、strict（只收 max_completion_tokens）、reasoning、ratelimit、badjson
// 1×1 PNG（圖片生成回傳用）
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export async function startFakeOpenAI() {
  const calls = [];
  const media = []; // 語音、生圖等非 chat 請求
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const path = new URL(req.url, "http://x").pathname;
    const err = (code, message, extra = {}) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message, type: "invalid_request_error", ...extra } }));
    };
    const json = (obj) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (!req.headers.authorization && !/ollama/.test(raw.toString())) {
      if (req.method === "GET" || path.endsWith("/transcriptions")) return err(401, "Incorrect API key provided");
    }
    // 模型清單（含 OpenRouter 格式的價格與輸入類型）
    if (req.method === "GET" && path.endsWith("/models")) {
      media.push({ path, headers: req.headers });
      return json({
        data: [
          { id: "gpt-test-chat", object: "model" },
          { id: "text-embedding-3-small", object: "model" },
          { id: "whisper-1", object: "model" },
          { id: "gpt-image-1", object: "model" },
          { id: "models/gemini-test-flash", object: "model" },
          { id: "vendor/vision-model", name: "Vendor: Vision Model", context_length: 200000, pricing: { prompt: "0.000003", completion: "0.000015" }, architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] } },
          { id: "vendor/audio-model", name: "Vendor: Audio Model", context_length: 100000, pricing: { prompt: "0.000001", completion: "0.000002" }, architecture: { input_modalities: ["text", "audio"], output_modalities: ["text"] } },
          { id: "vendor/image-gen", name: "Vendor: Image Gen", context_length: 8000, pricing: { prompt: "0", completion: "0.00004" }, architecture: { input_modalities: ["text"], output_modalities: ["image", "text"] } },
        ],
      });
    }
    // 語音轉文字（multipart）：故意回傳簡體字，以驗證程式會轉成臺灣用語
    if (path.endsWith("/audio/transcriptions")) {
      const form = raw.toString("latin1");
      const field = (n) => new RegExp(`name="${n}"\\r\\n\\r\\n([^\\r]*)`).exec(form)?.[1];
      const model = field("model");
      const fmt = field("response_format");
      media.push({ path, model, language: field("language"), format: fmt, prompt: Buffer.from(field("prompt") || "", "latin1").toString("utf8"), size: raw.length });
      if (raw.length > 26 * 1024 * 1024) return err(413, "Maximum content size limit exceeded");
      const text = "大家好，今天的会议讨论软件采购和网络设置。决议：下周三前完成报价。";
      if (fmt === "verbose_json") return json({ text, segments: [{ start: 0, end: 3.2, text: "大家好，今天的会议讨论软件采购和网络设置。" }, { start: 3.2, end: 6.5, text: "决议：下周三前完成报价。" }] });
      return json({ text });
    }
    // 圖片生成
    if (path.endsWith("/images/generations")) {
      const body = JSON.parse(raw.toString() || "{}");
      media.push({ path, ...body });
      if (/blocked/.test(body.prompt)) return json({ data: [] });
      return json({ data: Array.from({ length: body.n || 1 }, () => ({ b64_json: PNG_1PX })) });
    }
    const body = JSON.parse(raw.toString() || "{}");
    calls.push(body);
    // 音訊輸入（Gemini / OpenRouter）
    if (body.messages?.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === "input_audio"))) {
      media.push({ path, model: body.model, audio: true });
      return json({ choices: [{ message: { role: "assistant", content: "大家好，这是音频转写的结果。" } }] });
    }
    // OpenRouter 圖片模型（chat + modalities）
    if (body.modalities?.includes("image")) {
      media.push({ path, model: body.model, modalities: body.modalities });
      if (/blocked/.test(JSON.stringify(body.messages))) return json({ choices: [{ message: { role: "assistant", content: "I can't generate that.", images: [] } }] });
      return json({ choices: [{ message: { role: "assistant", content: "", images: [{ type: "image_url", image_url: { url: "data:image/png;base64," + PNG_1PX } }] } }] });
    }
    if (!req.headers.authorization && !/ollama/.test(body.model)) return err(401, "Incorrect API key provided");
    if (body.model === "ratelimit") return err(429, "Rate limit reached");
    if (body.model === "strict" && "max_tokens" in body)
      return err(400, "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", { param: "max_tokens", code: "unsupported_parameter" });
    if (body.model === "legacy" && "max_completion_tokens" in body) return err(400, "Unrecognized request argument supplied: max_completion_tokens");
    const sys = body.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const flat = (c) => (typeof c === "string" ? c : (c || []).map((x) => x.text || "").join("\n"));
    const user = body.messages.filter((m) => m.role !== "system").map((m) => flat(m.content)).join("\n");
    const hasImage = body.messages.some((m) => Array.isArray(m.content) && m.content.some((x) => x.type === "image_url"));
    const hasPdf = body.messages.some((m) => Array.isArray(m.content) && m.content.some((x) => x.type === "file" && /application\/pdf/.test(x.file?.file_data || "")));
    let { text, refuse } = fakeAnswer(sys, user, { hasImage, hasPdf });
    if (refuse) text = "I can't help with that.";
    if (body.model === "badjson" && (user.includes('"columns"') || user.includes('{"results":'))) text = "抱歉，這是說明文字而不是 JSON";
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta) => res.write(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta }] })}\n\n`);
    chunk({ role: "assistant", content: "" });
    if (body.model === "reasoning") for (let i = 0; i < 3; i++) chunk({ content: null, reasoning_content: "thinking..." });
    for (const piece of text.match(/[\s\S]{1,7}/g) || []) chunk({ content: piece });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  return { server, calls, media, base: (await listen(server)) + "/v1" };
}

// ---------------- 假 Claude API（Messages + SSE） ----------------
export async function startFakeClaude() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let b = "";
    for await (const c of req) b += c;
    const body = JSON.parse(b || "{}");
    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-09-01T00:00:00Z", max_input_tokens: 1000000 }, { type: "model", id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5", created_at: "2026-09-01T00:00:00Z", max_input_tokens: 1000000 }], has_more: false, first_id: "claude-opus-5-5", last_id: "claude-haiku-5-5" }));
    }
    calls.push({ path: req.url, headers: req.headers, body });
    const key = req.headers["x-api-key"] || (req.headers.authorization || "").replace(/^Bearer /, "");
    if (key !== "sk-ant-test") {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
    }
    const sys = typeof body.system === "string" ? body.system : (body.system || []).map((s) => s.text).join("\n");
    const user = body.messages.map((m) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text || "").join(""))).join("\n");
    const blocks = body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    const { text, refuse } = fakeAnswer(sys, user, { hasPdf: blocks.some((b) => b.type === "document"), hasImage: blocks.some((b) => b.type === "image") });
    const webSearch = (body.tools || []).some((t) => t.type?.startsWith("web_search"));
    const resumed = body.messages.at(-1)?.role === "assistant";
    res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_test" });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev("message_start", { message: { id: "msg_test", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    let idx = 0;
    let stop = refuse ? "refusal" : "end_turn";
    if (webSearch && !resumed) {
      // 模擬伺服器端網路搜尋：server_tool_use + web_search_tool_result
      ev("content_block_start", { index: idx, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} } });
      ev("content_block_delta", { index: idx, delta: { type: "input_json_delta", partial_json: '{"query":"test"}' } });
      ev("content_block_stop", { index: idx++ });
      ev("content_block_start", {
        index: idx,
        content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", title: "教育部公告", url: "https://www.edu.tw/news/1", encrypted_content: "x", page_age: null }, { type: "web_search_result", title: "大學新聞", url: "https://univ.example/2", encrypted_content: "y", page_age: null }] },
      });
      ev("content_block_stop", { index: idx++ });
      if (user.includes("PAUSE_ME")) stop = "pause_turn";
    }
    if (!refuse && stop !== "pause_turn") {
      const out = webSearch ? "## 研究報告\n\n根據教育部公告，補助每校最高 500 萬元。" : text;
      ev("content_block_start", { index: idx, content_block: { type: "text", text: "" } });
      for (const piece of out.match(/[\s\S]{1,7}/g) || []) ev("content_block_delta", { index: idx, delta: { type: "text_delta", text: piece } });
      ev("content_block_stop", { index: idx });
    }
    ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
    ev("message_stop", {});
    res.end();
  });
  return { server, calls, base: await listen(server) };
}

// ---------------- Webhook 接收器 ----------------
export async function startWebhook() {
  const received = [];
  const server = http.createServer(async (req, res) => {
    let b = "";
    for await (const c of req) b += c;
    received.push(JSON.parse(b));
    res.writeHead(200);
    res.end("ok");
  });
  return { server, received, url: (await listen(server)) + "/hook" };
}

export async function startWorld() {
  const [site, openai, claude, webhook, scholar] = await Promise.all([startWorldSite(), startFakeOpenAI(), startFakeClaude(), startWebhook(), startScholarMock()]);
  return {
    site,
    openai,
    claude,
    webhook,
    scholar,
    close: () => [site, openai, claude, webhook, scholar].forEach((x) => x.server.close()),
  };
}
