// AI 工作坊 —— 本機伺服器（Node 20+，無框架）
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSettings, saveSettings, publicSettings, listOutputs, outputPath, load } from "./lib/store.js";
import { generate, CLAUDE_MODELS, llmReady, withUsage, usageSummary, clearCache } from "./lib/llm.js";
import { parseDocument, SUPPORTED } from "./lib/docs.js";
import { translate, summarize, extractTable, toCsv, toXlsx, LANGUAGES } from "./lib/doctools.js";
import { writeOutput } from "./lib/store.js";
import { scrapePage, crawlSite, checkSite, reportToMarkdown } from "./lib/web.js";
import * as kb from "./lib/kb.js";
import * as flow from "./lib/flow.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, "public");
const PORT = Number(process.env.PORT) || 8790;
const HOST = process.env.HOST || "127.0.0.1";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

function json(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function body(req, limit = 40 * 1024 * 1024) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw Object.assign(new Error("檔案太大（上限 30 MB）"), { status: 413 });
    chunks.push(c);
  }
  const s = Buffer.concat(chunks).toString("utf8");
  return s ? JSON.parse(s) : {};
}

/** NDJSON 串流：回傳 send()，並在用戶中斷時觸發 signal */
function stream(req, res) {
  res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" });
  const ac = new AbortController();
  res.on("close", () => ac.abort());
  const send = (o) => {
    if (!res.writableEnded) res.write(JSON.stringify(o) + "\n");
  };
  return { send, signal: ac.signal, end: () => res.end() };
}

/** 包裝串流任務：錯誤一律以事件回報；並統計這次任務的 AI 用量 */
async function streamTask(req, res, fn) {
  const s = stream(req, res);
  const { usage } = await withUsage(async () => {
    try {
      await fn(s);
    } catch (e) {
      s.send({ type: "error", message: e.message });
    }
  });
  s.send({ type: "usage", usage });
  s.end();
}

/** 前端傳來的檔案：{ name, data(base64) } 或 fileId（檔案庫）或直接文字 */
async function resolveText(b) {
  if (b.text) return { title: b.title || "貼上的文字", text: b.text };
  if (b.fileId) {
    const { meta, text } = flow.getFileText(b.fileId);
    return { title: meta.name, text };
  }
  if (b.file?.data) {
    const parsed = await parseDocument(b.file.name, Buffer.from(b.file.data, "base64"));
    return { title: b.file.name, text: parsed.text };
  }
  if (b.url) {
    const p = await scrapePage(b.url);
    return { title: p.title, text: p.markdown, source: p.url };
  }
  throw Object.assign(new Error("請提供文字、檔案或網址"), { status: 400 });
}

const routes = {
  // ---- 基本 ----
  "GET /api/meta": (req, res) =>
    json(res, 200, { models: CLAUDE_MODELS, nodeTypes: flow.NODE_TYPES, templates: flow.TEMPLATES, languages: LANGUAGES, supported: SUPPORTED, ready: llmReady() }),
  "GET /api/settings": (req, res) => json(res, 200, publicSettings()),
  "POST /api/settings": async (req, res) => {
    saveSettings(await body(req));
    json(res, 200, { ...publicSettings(), ready: llmReady() });
  },
  "POST /api/settings/test": async (req, res) => {
    try {
      const r = await generate({ prompt: "請只回覆「連線成功」。", maxTokens: 2000, light: true, noCache: true });
      json(res, 200, { ok: true, text: r.text.trim(), model: r.model });
    } catch (e) {
      json(res, 200, { ok: false, error: e.message });
    }
  },
  "GET /api/outputs": (req, res) => json(res, 200, listOutputs()),
  "GET /api/usage": (req, res) => json(res, 200, usageSummary()),
  "POST /api/cache/clear": (req, res) => json(res, 200, { removed: clearCache() }),

  // ---- 檔案庫 ----
  "GET /api/files": (req, res) => json(res, 200, flow.listFiles()),
  "POST /api/files": async (req, res) => {
    const b = await body(req);
    const f = await flow.addFile(b.name, Buffer.from(b.data, "base64"));
    json(res, 200, { ...f, text: f.text.slice(0, 3000) });
  },
  "GET /api/files/text": (req, res, url) => {
    const { meta, text } = flow.getFileText(url.searchParams.get("id"));
    json(res, 200, { meta, text });
  },
  "DELETE /api/files": (req, res, url) => {
    flow.deleteFile(url.searchParams.get("id"));
    json(res, 200, { ok: true });
  },

  // ---- 文件工具 ----
  "POST /api/doc/parse": async (req, res) => {
    const t = await resolveText(await body(req));
    json(res, 200, { ...t, chars: t.text.length });
  },
  "POST /api/doc/translate": (req, res) =>
    streamTask(req, res, async ({ send, signal }) => {
      const b = await body(req);
      const { title, text } = await resolveText(b);
      send({ type: "log", message: `開始翻譯「${title}」（${text.length} 字）` });
      const out = await translate(text, { target: b.target, glossary: b.glossary, signal, onText: (d) => send({ type: "text", delta: d }), onProgress: (p) => send({ type: "progress", ...p }) });
      const file = writeOutput(`${title}-${b.target}.md`, out);
      send({ type: "done", output: out, files: [file] });
    }),
  "POST /api/doc/summarize": (req, res) =>
    streamTask(req, res, async ({ send, signal }) => {
      const b = await body(req);
      const { title, text } = await resolveText(b);
      send({ type: "log", message: `開始摘要「${title}」（${text.length} 字）` });
      const out = await summarize(text, { style: b.style, length: b.length, signal, onText: (d) => send({ type: "text", delta: d }), onProgress: (p) => send({ type: "progress", ...p }) });
      const file = writeOutput(`${title}-摘要.md`, out);
      send({ type: "done", output: out, files: [file] });
    }),
  "POST /api/doc/extract": (req, res) =>
    streamTask(req, res, async ({ send, signal }) => {
      const b = await body(req);
      const { title, text } = await resolveText(b);
      send({ type: "log", message: `從「${title}」擷取資料…` });
      const table = await extractTable(text, { fields: b.fields, instruction: b.instruction, signal, onProgress: (p) => send({ type: "progress", ...p }) });
      const base = title.replace(/\.\w+$/, "");
      const files = [writeOutput(`${base}-擷取.xlsx`, await toXlsx(table)), writeOutput(`${base}-擷取.csv`, toCsv(table))];
      send({ type: "done", table, files });
    }),
  "POST /api/doc/convert": async (req, res) => {
    // 檔案 → Markdown（不需 AI）
    const b = await body(req);
    const { title, text } = await resolveText(b);
    const file = writeOutput(`${title.replace(/\.\w+$/, "")}.md`, text);
    json(res, 200, { title, text, files: [file] });
  },

  // ---- 網站 ----
  "POST /api/web/scrape": async (req, res) => {
    const b = await body(req);
    const p = await scrapePage(b.url, { mode: b.mode });
    const file = writeOutput(`${new URL(p.url).hostname}.md`, `# ${p.title}\n\n來源：${p.url}\n\n${p.markdown}`);
    json(res, 200, { ...p, files: [file] });
  },
  "POST /api/web/crawl": (req, res) =>
    streamTask(req, res, async ({ send, signal }) => {
      const b = await body(req);
      const r = await crawlSite(b.url, {
        maxPages: Math.min(Number(b.maxPages) || 20, 200),
        maxDepth: Number(b.maxDepth) || 2,
        include: b.include,
        exclude: b.exclude,
        signal,
        onPage: (p, s) => send(p ? { type: "page", url: p.url, title: p.title, chars: p.markdown.length, ...s } : { type: "log", message: s.error }),
      });
      const md = r.pages.map((p) => `# ${p.title}\n\n來源：${p.url}\n\n${p.markdown}`).join("\n\n---\n\n");
      const host = r.pages[0] ? new URL(r.pages[0].url).hostname : "site";
      const files = [writeOutput(`${host}-爬取.md`, md), writeOutput(`${host}-爬取.json`, JSON.stringify(r.pages, null, 2))];
      let kbResult;
      if (b.kbId && r.pages.length) {
        for (const p of r.pages) kb.addDocument(b.kbId, { title: p.title || p.url, text: p.markdown, source: p.url, kind: "web" });
        kbResult = { added: r.pages.length };
      }
      send({ type: "done", pages: r.pages.length, errors: r.errors, files, kbResult });
    }),
  "POST /api/web/check": (req, res) =>
    streamTask(req, res, async ({ send, signal }) => {
      const b = await body(req);
      const r = await checkSite(b.url, { signal, onStep: (step, data) => send({ type: "step", step, data }) });
      const md = reportToMarkdown(r);
      const files = [writeOutput(`網站檢測-${r.host}.md`, md)];
      send({ type: "done", report: r, markdown: md, files });
    }),
  "POST /api/web/advise": (req, res) =>
    streamTask(req, res, async ({ send, signal }) => {
      const b = await body(req);
      const { text } = await generate(
        { prompt: `以下是網站檢測報告。請用繁體中文列出最該優先處理的問題（依嚴重程度排序），每個問題說明風險並給出具體修正方法與設定範例（Nginx、Apache、Cloudflare 或 HTML）。\n\n${b.markdown}` },
        (d) => send({ type: "text", delta: d }),
        signal,
      );
      send({ type: "done", output: text });
    }),

  // ---- 知識庫 ----
  "GET /api/kb": (req, res) => json(res, 200, kb.listKbs()),
  "POST /api/kb": async (req, res) => {
    const b = await body(req);
    json(res, 200, kb.createKb(b.name, b.description));
  },
  "GET /api/kb/detail": (req, res, url) => {
    const k = kb.getKb(url.searchParams.get("id"));
    json(res, 200, { id: k.id, name: k.name, description: k.description, docs: k.docs, chunks: k.chunks.length });
  },
  "DELETE /api/kb": (req, res, url) => {
    kb.deleteKb(url.searchParams.get("id"));
    json(res, 200, { ok: true });
  },
  "POST /api/kb/docs": async (req, res) => {
    const b = await body(req);
    const t = await resolveText(b);
    const r = kb.addDocument(b.kbId, { title: b.title || t.title, text: t.text, source: t.source || "", kind: b.file ? "file" : b.url ? "web" : "text" });
    json(res, 200, r);
  },
  "DELETE /api/kb/docs": (req, res, url) => {
    kb.removeDocument(url.searchParams.get("kbId"), url.searchParams.get("docId"));
    json(res, 200, { ok: true });
  },
  "POST /api/kb/search": async (req, res) => {
    const b = await body(req);
    json(res, 200, kb.search(kb.getKb(b.kbId), b.query, b.k || 8));
  },
  "POST /api/kb/ask": (req, res) =>
    streamTask(req, res, async ({ send, signal }) => {
      const b = await body(req);
      const r = await kb.ask(b.kbId, b.question, { history: b.history || [], signal, onText: (d) => send({ type: "text", delta: d }) });
      send({ type: "done", answer: r.answer, sources: r.sources.map(({ n, title, heading, text, score }) => ({ n, title, heading, text, score })) });
    }),

  // ---- 工作流 ----
  "GET /api/flows": (req, res) => json(res, 200, flow.listFlows()),
  "POST /api/flows": async (req, res) => json(res, 200, flow.saveFlow(await body(req))),
  "DELETE /api/flows": (req, res, url) => {
    flow.deleteFlow(url.searchParams.get("id"));
    json(res, 200, { ok: true });
  },
  "POST /api/flows/run": (req, res) =>
    streamTask(req, res, async ({ send, signal }) => {
      const b = await body(req);
      const f = b.flow || flow.getFlow(b.id);
      if (!f) throw new Error("找不到工作流");
      await flow.runFlow(f, { input: b.input || "", emit: send, signal, settings: getSettings() });
    }),
  "GET /api/runs": (req, res) => json(res, 200, load("runs", [])),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    // 防止其他網站透過瀏覽器呼叫本機 API（CSRF）
    const origin = req.headers.origin;
    if (origin && req.method !== "GET" && new URL(origin).host !== req.headers.host) return json(res, 403, { error: "不允許跨站請求" });

    if (req.method === "GET" && url.pathname.startsWith("/api/outputs/")) {
      const p = outputPath(decodeURIComponent(url.pathname.slice("/api/outputs/".length)));
      if (!p) return json(res, 404, { error: "檔案不存在" });
      const name = path.basename(p).replace(/^\d+_/, "");
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}` });
      return fs.createReadStream(p).pipe(res);
    }
    const handler = routes[`${req.method} ${url.pathname}`];
    if (handler) return await handler(req, res, url);
    if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "API 不存在" });
    const file = path.normalize(path.join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(200, { "content-type": MIME[".html"] });
      return fs.createReadStream(path.join(PUBLIC, "index.html")).pipe(res);
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    if (!res.headersSent) json(res, e.status || 500, { error: e.message });
    else res.end();
  }
});

export { server };

// 直接執行（node server.js）時才啟動；Windows 上磁碟代號大小寫可能不同，所以不分大小寫比較
const sameFile = (a, b) => (process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
if (process.argv[1] && sameFile(process.argv[1], fileURLToPath(import.meta.url))) {
  server.listen(PORT, HOST, () => {
    console.log(`\n  🧪 AI 工作坊已啟動：http://${HOST}:${PORT}\n`);
    if (!llmReady()) console.log("  尚未設定 API Key —— 請在網頁的「設定」頁輸入。\n");
  });
  flow.startScheduler(getSettings);
}
