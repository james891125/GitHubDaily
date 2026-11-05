// GitHubDaily 工作台 —— 本機伺服器（無框架，Node 18+）
// 使用者的 API Key 只存在瀏覽器 localStorage，每次請求時透過標頭傳給本機伺服器，
// 伺服器不會將金鑰寫入硬碟或記錄。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog, searchCatalog, catalogStats } from "./lib/catalog.js";
import { getRepoInfo, getReadme, healthOf } from "./lib/github.js";
import { runWorkflow, PRESET_WORKFLOWS, STEP_TYPES } from "./lib/workflows.js";
import { generate, CLAUDE_MODELS } from "./lib/llm.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const PUBLIC = path.join(here, "public");
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || "127.0.0.1";

let catalog = loadCatalog(ROOT);
const stats = () => catalogStats(catalog);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readBody(req, limit = 2_000_000) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error("請求內容過大"), { status: 413 });
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

/** 從請求標頭取得使用者設定（金鑰不落地）。環境變數僅作為備援。 */
function llmConfig(req) {
  const h = req.headers;
  const provider = h["x-llm-provider"] || "anthropic";
  return {
    provider,
    apiKey: h["x-llm-key"] || (provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY) || "",
    model: h["x-llm-model"] || undefined,
    baseUrl: h["x-llm-base-url"] || undefined,
    effort: h["x-llm-effort"] || undefined,
  };
}
const githubToken = (req) => req.headers["x-github-token"] || process.env.GITHUB_TOKEN || "";

function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC, pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(PUBLIC)) return sendJson(res, 403, { error: "forbidden" });
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(PUBLIC, "index.html"), (e2, html) => {
        if (e2) return sendJson(res, 404, { error: "not found" });
        res.writeHead(200, { "content-type": MIME[".html"] });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

/** NDJSON 串流回應 */
function startStream(res) {
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
  });
  return (obj) => res.write(JSON.stringify(obj) + "\n");
}

const routes = {
  "GET /api/meta": (req, res) =>
    sendJson(res, 200, { stats: stats(), models: CLAUDE_MODELS, stepTypes: STEP_TYPES, presets: PRESET_WORKFLOWS }),

  "GET /api/projects": (req, res, url) => {
    const q = url.searchParams.get("q") || "";
    const category = url.searchParams.get("category") || undefined;
    const year = url.searchParams.get("year") || undefined;
    const offset = Number(url.searchParams.get("offset")) || 0;
    const limit = Math.min(Number(url.searchParams.get("limit")) || 60, 500);
    const all = searchCatalog(catalog, q, { limit: 100000, category, year });
    sendJson(res, 200, { total: all.length, items: all.slice(offset, offset + limit) });
  },

  "GET /api/projects/by-ids": (req, res, url) => {
    const ids = new Set((url.searchParams.get("ids") || "").split(",").map(Number));
    sendJson(res, 200, { items: catalog.filter((p) => ids.has(p.id)) });
  },

  "GET /api/github/repo": async (req, res, url) => {
    const repo = url.searchParams.get("repo");
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return sendJson(res, 400, { error: "repo 參數格式應為 owner/name" });
    try {
      const info = await getRepoInfo(repo, githubToken(req));
      const withReadme = url.searchParams.get("readme") === "1";
      sendJson(res, 200, { info, health: healthOf(info), readme: withReadme ? await getReadme(repo, githubToken(req)) : undefined });
    } catch (e) {
      sendJson(res, e.status || 500, { error: e.message });
    }
  },

  // 批次健康檢查（收藏清單）
  "POST /api/github/batch": async (req, res) => {
    const { repos = [] } = await readBody(req);
    const send = startStream(res);
    for (const repo of repos.slice(0, 100)) {
      try {
        const info = await getRepoInfo(repo, githubToken(req));
        send({ repo, info, health: healthOf(info) });
      } catch (e) {
        send({ repo, error: e.message });
        if (e.status === 403 || e.status === 401) break;
      }
    }
    res.end();
  },

  // 測試金鑰
  "POST /api/llm/test": async (req, res) => {
    try {
      const { text, model } = await generate(llmConfig(req), { prompt: "請只回覆「連線成功」四個字。", maxTokens: 2000 });
      sendJson(res, 200, { ok: true, text: text.trim(), model });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: e.message });
    }
  },

  // 自由對話 / 單次提示（串流）
  "POST /api/llm/chat": async (req, res) => {
    const { prompt, system } = await readBody(req);
    const send = startStream(res);
    try {
      const r = await generate(llmConfig(req), { prompt, system }, (delta) => send({ type: "text", delta }));
      send({ type: "done", model: r.model });
    } catch (e) {
      send({ type: "error", message: e.message });
    }
    res.end();
  },

  // 執行流程（串流事件）
  "POST /api/workflows/run": async (req, res) => {
    const { workflow, input } = await readBody(req);
    if (!workflow?.steps?.length) return sendJson(res, 400, { error: "流程沒有任何步驟" });
    const send = startStream(res);
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    try {
      await runWorkflow(workflow, {
        input,
        catalog,
        llm: llmConfig(req),
        githubToken: githubToken(req),
        emit: send,
        signal: ac.signal,
      });
    } catch (e) {
      send({ type: "error", message: e.message });
    }
    res.end();
  },

  "POST /api/catalog/reload": (req, res) => {
    catalog = loadCatalog(ROOT);
    sendJson(res, 200, { stats: stats() });
  },
};

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const handler = routes[`${req.method} ${url.pathname}`];
  try {
    if (handler) return await handler(req, res, url);
    if (url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "API 不存在" });
    if (req.method === "GET") return serveStatic(req, res, url.pathname);
    sendJson(res, 405, { error: "method not allowed" });
  } catch (e) {
    if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message });
    else res.end();
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => {
    const s = stats();
    console.log(`\n  GitHubDaily 工作台已啟動：http://${HOST}:${PORT}`);
    console.log(`  已載入 ${s.total} 個開源專案（${Object.keys(s.categories).length} 個分類）\n`);
  });
}
