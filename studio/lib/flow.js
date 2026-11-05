// AI 工作流引擎：依序執行節點，節點之間以變數傳遞資料。
// 模板語法：{{變數}}、{{變數.欄位}}、{{input}}、{{today}}、{{now}}
import fs from "node:fs";
import path from "node:path";
import { load, save, newId, writeOutput, DATA_DIR } from "./store.js";
import { generate, generateJson, withUsage, currentUsage } from "./llm.js";
import { scrapePage, crawlSite, checkSite, reportToMarkdown } from "./web.js";
import { translate, summarize, extractTable, toCsv, toXlsx, toMarkdownTable, compactText, chunkLimits } from "./doctools.js";
import { parseDocument } from "./docs.js";
import * as kb from "./kb.js";

// ---------- 節點定義（前端依此產生表單） ----------
export const NODE_TYPES = {
  fetch_url: {
    label: "🌐 擷取網頁",
    desc: "抓取網址內容並轉成 Markdown",
    fields: { url: { label: "網址（可用變數）", type: "text", default: "{{input}}" }, mode: { label: "模式", type: "select", options: { article: "只取正文", full: "整頁" }, default: "article" } },
    out: "page",
  },
  crawl: {
    label: "🕷️ 爬取網站",
    desc: "從起始網址爬取同網域多個頁面",
    fields: {
      url: { label: "起始網址", type: "text", default: "{{input}}" },
      maxPages: { label: "最多頁數", type: "number", default: 10 },
      maxDepth: { label: "最大深度", type: "number", default: 2 },
      include: { label: "只爬符合（正則，選填）", type: "text", default: "" },
    },
    out: "site",
  },
  http: {
    label: "🔌 呼叫 API",
    desc: "發送 HTTP 請求到任何 API，回傳 JSON 或文字",
    fields: {
      method: { label: "方法", type: "select", options: { GET: "GET", POST: "POST", PUT: "PUT" }, default: "GET" },
      url: { label: "網址", type: "text", default: "" },
      headers: { label: "標頭（每行 Key: Value）", type: "textarea", default: "" },
      body: { label: "內容（POST/PUT）", type: "textarea", default: "" },
    },
    out: "api",
  },
  read_file: {
    label: "📄 讀取檔案",
    desc: "讀取檔案庫中的 PDF / Word / Excel / 文字檔",
    fields: { fileId: { label: "檔案", type: "file", default: "" } },
    out: "doc",
  },
  kb_search: {
    label: "🔎 知識庫檢索",
    desc: "從知識庫找出與問題最相關的段落",
    fields: { kbId: { label: "知識庫", type: "kb", default: "" }, query: { label: "查詢", type: "text", default: "{{input}}" }, k: { label: "段落數", type: "number", default: 4 } },
    out: "context",
  },
  kb_add: {
    label: "📚 存入知識庫",
    desc: "把文字或爬取結果加入知識庫",
    fields: { kbId: { label: "知識庫", type: "kb", default: "" }, source: { label: "內容來源變數", type: "text", default: "{{site}}" }, title: { label: "標題", type: "text", default: "{{input}}" } },
    out: "kbResult",
  },
  llm: {
    label: "🤖 AI 處理",
    desc: "用自訂提示讓 AI 處理資料",
    fields: { prompt: { label: "提示", type: "textarea", default: "請整理以下內容的重點：\n\n{{page}}" }, system: { label: "角色設定（選填）", type: "textarea", default: "" } },
    out: "ai",
  },
  llm_each: {
    label: "🔁 逐項 AI 處理",
    desc: "對清單中的每一項分別執行提示（例如每個網址、每一頁、每一行）",
    fields: {
      list: { label: "清單來源（變數或每行一項）", type: "text", default: "{{input}}" },
      prompt: { label: "每項的提示（用 {{item}}）", type: "textarea", default: "請用三句話摘要：\n{{item}}" },
      fetch: { label: "每項若是網址，先擷取網頁內容", type: "checkbox", default: false },
    },
    out: "items",
  },
  translate: {
    label: "🌏 翻譯",
    desc: "分段翻譯長文並保留格式",
    fields: {
      source: { label: "內容", type: "text", default: "{{page}}" },
      target: { label: "目標語言", type: "select", options: { "zh-TW": "繁體中文", "zh-CN": "简体中文", en: "English", ja: "日本語", ko: "한국어" }, default: "zh-TW" },
    },
    out: "translated",
  },
  summarize: {
    label: "📝 摘要",
    desc: "長文自動分段摘要",
    fields: { source: { label: "內容", type: "text", default: "{{page}}" }, style: { label: "風格", type: "text", default: "重點條列" } },
    out: "summary",
  },
  extract: {
    label: "📊 擷取成表格",
    desc: "從文字擷取指定欄位成表格資料",
    fields: { source: { label: "內容", type: "text", default: "{{doc}}" }, fields: { label: "欄位（逗號分隔）", type: "text", default: "名稱, 價格, 說明" }, instruction: { label: "擷取條件（選填）", type: "text", default: "" } },
    out: "table",
  },
  site_check: {
    label: "🩺 網站檢測",
    desc: "檢查 SSL、DNS、安全標頭、SEO、失效連結並評分",
    fields: { url: { label: "網址", type: "text", default: "{{input}}" } },
    out: "check",
  },
  condition: {
    label: "🚦 條件判斷",
    desc: "條件不成立時，停止執行後續節點",
    fields: {
      left: { label: "值", type: "text", default: "{{check.score}}" },
      op: { label: "比較", type: "select", options: { lt: "小於", gt: "大於", eq: "等於", ne: "不等於", contains: "包含", not_contains: "不包含", changed: "與上次執行不同" }, default: "lt" },
      right: { label: "比較值", type: "text", default: "80" },
    },
    out: "",
  },
  set: {
    label: "✏️ 組合文字",
    desc: "用模板組出新的變數內容",
    fields: { value: { label: "內容", type: "textarea", default: "# 報告 {{today}}\n\n{{ai}}" } },
    out: "text",
  },
  save_file: {
    label: "💾 輸出檔案",
    desc: "存成 Markdown / 文字 / CSV / Excel / JSON",
    fields: {
      source: { label: "內容", type: "text", default: "{{ai}}" },
      format: { label: "格式", type: "select", options: { md: "Markdown (.md)", txt: "文字 (.txt)", csv: "CSV", xlsx: "Excel (.xlsx)", json: "JSON" }, default: "md" },
      filename: { label: "檔名", type: "text", default: "報告-{{today}}" },
    },
    out: "file",
  },
  webhook: {
    label: "📣 發送通知",
    desc: "POST 到 Slack / Discord / Teams 等 Webhook",
    fields: { url: { label: "Webhook 網址（空白則用設定中的預設）", type: "text", default: "" }, message: { label: "訊息", type: "textarea", default: "{{ai}}" } },
    out: "",
  },
};

// ---------- 模板 ----------
function getPath(vars, p) {
  return p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), vars);
}

/** 將任何值轉成適合放進提示的文字 */
export function stringify(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v.__type === "page") return `# ${v.title}\n來源：${v.url}\n\n${compactText(v.markdown)}`;
  if (v.__type === "site") return v.pages.map((p) => `# ${p.title}\n來源：${p.url}\n\n${compactText(p.markdown)}`).join("\n\n---\n\n");
  if (v.__type === "table") return toMarkdownTable(v);
  if (v.__type === "doc") return v.text;
  if (v.__type === "check") return v.markdown;
  if (v.__type === "items") return v.results.map((r, i) => `## ${i + 1}. ${r.item.slice(0, 120)}\n\n${r.output}`).join("\n\n");
  if (v.__type === "file") return v.url;
  return JSON.stringify(v, null, 2);
}

export function render(tpl, vars) {
  return String(tpl ?? "").replace(/\{\{\s*([\w.一-鿿-]+)\s*\}\}/g, (_, p) => stringify(getPath(vars, p)));
}

/** 若模板剛好是單一變數，取得原始值（保留表格、頁面等結構） */
function resolveRaw(tpl, vars) {
  const m = /^\s*\{\{\s*([\w.一-鿿-]+)\s*\}\}\s*$/.exec(String(tpl || ""));
  return m ? getPath(vars, m[1]) : render(tpl, vars);
}

function toList(v) {
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : stringify(x)));
  if (v?.__type === "site") return v.pages.map((p) => stringify({ ...p, __type: "page" }));
  if (v?.__type === "table") return v.rows.map((r) => Object.entries(r).map(([k, x]) => `${k}：${x}`).join("\n"));
  if (v?.__type === "items") return v.results.map((r) => r.output);
  return stringify(v)
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------- 檔案庫 ----------
const FILES_DIR = path.join(DATA_DIR, "files");
fs.mkdirSync(FILES_DIR, { recursive: true });

export function listFiles() {
  return load("files-index", []);
}
export async function addFile(name, buf) {
  const id = newId();
  const parsed = await parseDocument(name, buf);
  fs.writeFileSync(path.join(FILES_DIR, id + ".txt"), parsed.text);
  const meta = { id, name, kind: parsed.kind, pages: parsed.pages, chars: parsed.text.length, addedAt: new Date().toISOString() };
  save("files-index", [meta, ...listFiles()]);
  return { ...meta, text: parsed.text };
}
export function getFileText(id) {
  const meta = listFiles().find((f) => f.id === id);
  if (!meta) throw new Error("找不到檔案，請在節點中重新選擇");
  return { meta, text: fs.readFileSync(path.join(FILES_DIR, id + ".txt"), "utf8") };
}
export function deleteFile(id) {
  save("files-index", listFiles().filter((f) => f.id !== id));
  fs.rmSync(path.join(FILES_DIR, id + ".txt"), { force: true });
}

// ---------- 執行 ----------
class StopFlow extends Error {}

function parseHeaders(text, vars) {
  const h = {};
  for (const line of render(text, vars).split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) h[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return h;
}

async function runNode(node, vars, ctx) {
  const { emit, signal, flow } = ctx;
  const log = (m) => emit({ type: "log", node: node.id, message: m });
  const onText = (d) => emit({ type: "text", node: node.id, delta: d });
  const progress = ({ done, total }) => log(`進度 ${done}/${total}`);

  switch (node.type) {
    case "fetch_url": {
      const url = render(node.url, vars).trim();
      log(`擷取 ${url}`);
      const p = await scrapePage(url, { mode: node.mode, signal, log });
      log(`取得「${p.title}」，${p.markdown.length} 字`);
      return { __type: "page", url: p.url, title: p.title, markdown: p.markdown, links: p.links.slice(0, 200).map((l) => l.url) };
    }
    case "crawl": {
      const url = render(node.url, vars).trim();
      const r = await crawlSite(url, {
        maxPages: Number(node.maxPages) || 10,
        maxDepth: Number(node.maxDepth) || 2,
        include: node.include || "",
        signal,
        onPage: (p, s) => log(p ? `✓ ${p.url}（${s.done}）` : `✗ ${s.error}`),
      });
      return { __type: "site", start: url, pages: r.pages.map((p) => ({ url: p.url, title: p.title, markdown: p.markdown })), errors: r.errors };
    }
    case "http": {
      const url = render(node.url, vars).trim();
      const method = node.method || "GET";
      const headers = parseHeaders(node.headers || "", vars);
      const body = method === "GET" ? undefined : render(node.body || "", vars);
      if (body && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
      log(`${method} ${url}`);
      const res = await fetch(url, { method, headers, body, signal });
      const text = await res.text();
      log(`HTTP ${res.status}，${text.length} 字元`);
      if (!res.ok) throw new Error(`API 回應 HTTP ${res.status}：${text.slice(0, 200)}`);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    case "read_file": {
      const { meta, text } = getFileText(node.fileId);
      log(`讀取「${meta.name}」，${text.length} 字`);
      return { __type: "doc", name: meta.name, text };
    }
    case "kb_search": {
      const k = kb.getKb(node.kbId);
      const hits = kb.search(k, render(node.query, vars), Number(node.k) || 6);
      log(`找到 ${hits.length} 段相關內容`);
      return hits.map((h, i) => `[${i + 1}] 《${h.title}》\n${h.text}`).join("\n\n---\n\n") || "（知識庫中沒有找到相關內容）";
    }
    case "kb_add": {
      const src = resolveRaw(node.source, vars);
      let added = 0;
      if (src?.__type === "site") {
        for (const p of src.pages) {
          kb.addDocument(node.kbId, { title: p.title || p.url, text: p.markdown, source: p.url, kind: "web" });
          added++;
        }
      } else {
        kb.addDocument(node.kbId, { title: render(node.title, vars) || "工作流內容", text: stringify(src), source: src?.url || "", kind: src?.__type || "text" });
        added = 1;
      }
      log(`已存入 ${added} 份文件`);
      return { added };
    }
    case "llm": {
      const { text } = await generate({ prompt: render(node.prompt, vars), system: render(node.system || "", vars) || "請使用繁體中文回答，以 Markdown 格式輸出。" }, onText, signal);
      return text;
    }
    case "llm_each": {
      const list = toList(resolveRaw(node.list, vars)).slice(0, 50);
      log(`共 ${list.length} 項`);
      // 1. 先取得每一項的內容（網址就先擷取）
      const items = [];
      const results = new Array(list.length);
      for (const [i, item] of list.entries()) {
        if (signal?.aborted) throw new Error("已取消");
        let content = item;
        if (node.fetch && /^https?:\/\//.test(item)) {
          try {
            const p = await scrapePage(item, { signal, log });
            content = `# ${p.title}\n來源：${p.url}\n\n${compactText(p.markdown).slice(0, 30000)}`;
          } catch (e) {
            results[i] = { item, output: `（擷取失敗：${e.message}）` };
            log(`✗ ${i + 1}/${list.length} ${e.message}`);
            continue;
          }
        }
        items.push({ i, item, content });
      }
      // 2. 合併成批次，一次請 AI 處理多項（N 項通常只需 1 次呼叫，而不是 N 次）
      const budget = Math.min(chunkLimits().extract, 60000);
      const batches = [];
      let cur = [];
      let size = 0;
      for (const it of items) {
        if (cur.length && (size + it.content.length > budget || cur.length >= 20)) {
          batches.push(cur);
          cur = [];
          size = 0;
        }
        cur.push(it);
        size += it.content.length;
      }
      if (cur.length) batches.push(cur);
      const schema = { type: "object", properties: { results: { type: "array", items: { type: "string" } } }, required: ["results"], additionalProperties: false };
      for (const batch of batches) {
        if (signal?.aborted) throw new Error("已取消");
        let outputs = null;
        if (batch.length > 1) {
          const blocks = batch.map((it, k) => `<item id="${k + 1}">\n${render(node.prompt, { ...vars, item: it.content, index: it.i + 1 })}\n</item>`).join("\n\n");
          try {
            const data = await generateJson(
              `以下有 ${batch.length} 個獨立的工作，請分別完成每一個 <item> 中的要求，彼此不要混用內容。\n輸出 {"results":["第1項的結果","第2項的結果",...]}，共 ${batch.length} 個字串，順序與 id 相同；每個結果可使用 Markdown。\n\n${blocks}`,
              { system: "請使用繁體中文回答。", schema, light: false, signal },
            );
            if (Array.isArray(data.results) && data.results.length === batch.length) outputs = data.results.map(String);
            else log("AI 回傳的項目數量不符，改為逐項處理");
          } catch (e) {
            if (signal?.aborted) throw e;
            log(`批次處理失敗（${e.message}），改為逐項處理`);
          }
        }
        if (!outputs) {
          outputs = [];
          for (const it of batch) {
            const { text } = await generate({ prompt: render(node.prompt, { ...vars, item: it.content, index: it.i + 1 }), system: "請使用繁體中文回答。" }, undefined, signal);
            outputs.push(text);
          }
        }
        batch.forEach((it, k) => (results[it.i] = { item: it.item, output: outputs[k] }));
        log(`✓ 已完成 ${results.filter(Boolean).length}/${list.length}（本批 ${batch.length} 項，1 次呼叫）`);
      }
      return { __type: "items", results: results.filter(Boolean) };
    }
    case "translate":
      return translate(stringify(resolveRaw(node.source, vars)), { target: node.target, onText, onProgress: progress, signal });
    case "summarize":
      return summarize(stringify(resolveRaw(node.source, vars)), { style: render(node.style, vars), onText, onProgress: progress, signal });
    case "extract": {
      const t = await extractTable(stringify(resolveRaw(node.source, vars)), { fields: render(node.fields, vars), instruction: render(node.instruction, vars), onProgress: progress, signal });
      log(`擷取到 ${t.rows.length} 筆資料`);
      return { __type: "table", ...t };
    }
    case "site_check": {
      const r = await checkSite(render(node.url, vars), { signal, onStep: (s) => log(`完成：${s}`) });
      log(`分數 ${r.score.score}（${r.score.grade}），${r.score.issues.length} 個問題`);
      return { __type: "check", score: r.score.score, grade: r.score.grade, issues: r.score.issues.map((i) => `【${i.level}】${i.msg}`).join("\n"), markdown: reportToMarkdown(r), host: r.host };
    }
    case "condition": {
      const left = render(node.left, vars);
      const right = render(node.right, vars);
      let ok;
      switch (node.op) {
        case "lt": ok = Number(left) < Number(right); break;
        case "gt": ok = Number(left) > Number(right); break;
        case "eq": ok = left.trim() === right.trim(); break;
        case "ne": ok = left.trim() !== right.trim(); break;
        case "contains": ok = left.includes(right); break;
        case "not_contains": ok = !left.includes(right); break;
        case "changed": {
          const memo = load("flow-memo", {});
          const key = `${flow.id}:${node.id}`;
          ok = memo[key] !== undefined && memo[key] !== left;
          if (memo[key] === undefined) log("第一次執行，記錄目前內容作為基準");
          memo[key] = left;
          save("flow-memo", memo);
          break;
        }
        default: ok = true;
      }
      const shortLeft = left.length > 40 ? left.slice(0, 40) + "…" : left;
      log(`「${shortLeft}」${NODE_TYPES.condition.fields.op.options[node.op]}「${right}」→ ${ok ? "成立，繼續" : "不成立，停止"}`);
      if (!ok) throw new StopFlow();
      return undefined;
    }
    case "set":
      return render(node.value, vars);
    case "save_file": {
      const src = resolveRaw(node.source, vars);
      const fmt = node.format || "md";
      const base = render(node.filename || "output", vars);
      let data;
      if (fmt === "csv" || fmt === "xlsx") {
        const table = src?.__type === "table" ? src : Array.isArray(src) && src.length && typeof src[0] === "object" ? { columns: Object.keys(src[0]), rows: src } : null;
        if (!table) throw new Error("CSV / Excel 需要表格資料（例如「擷取成表格」節點的輸出）");
        data = fmt === "csv" ? toCsv(table) : await toXlsx(table);
      } else if (fmt === "json") data = JSON.stringify(src, null, 2);
      else data = stringify(src);
      const f = writeOutput(`${base}.${fmt}`, data);
      log(`已儲存 ${f.name}`);
      emit({ type: "file", node: node.id, file: f });
      return { __type: "file", ...f };
    }
    case "webhook": {
      const url = render(node.url, vars).trim() || ctx.settings.webhookUrl;
      if (!url) throw new Error("沒有 Webhook 網址（節點或設定頁都未填）");
      const message = render(node.message, vars).slice(0, 3900);
      // 同時提供 Slack（text）與 Discord（content）格式
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: message, content: message.slice(0, 1990) }), signal });
      log(`通知已送出（HTTP ${res.status}）`);
      if (!res.ok) throw new Error(`Webhook 回應 HTTP ${res.status}`);
      return undefined;
    }
    default:
      throw new Error(`未知節點類型：${node.type}`);
  }
}

/**
 * 執行工作流。emit 事件：node-start / log / text / file / node-done / node-error / stopped / done
 */
export async function runFlow(flow, opts = {}) {
  const { result, usage } = await withUsage(() => runFlowInner(flow, opts));
  result.usage = usage;
  // 把用量補記到執行紀錄
  const runs = load("runs", []);
  const r = runs.find((x) => x.id === result.id);
  if (r) {
    r.usage = usage;
    save("runs", runs);
  }
  opts.emit?.({ type: "usage", usage });
  return result;
}

async function runFlowInner(flow, { input = "", emit = () => {}, signal, settings = {}, trigger = "manual" } = {}) {
  const now = new Date();
  const vars = {
    input,
    today: now.toLocaleDateString("sv-SE"),
    now: now.toLocaleString("zh-TW", { hour12: false }),
  };
  const run = { id: newId(), flowId: flow.id, flowName: flow.name, trigger, input, startedAt: now.toISOString(), status: "running", logs: [], files: [] };
  const record = (ev) => {
    if (ev.type === "log") run.logs.push(`[${ev.node}] ${ev.message}`);
    if (ev.type === "file") run.files.push(ev.file);
    emit(ev);
  };
  const ctx = { emit: record, signal, flow, settings };
  let lastOutput;
  try {
    for (const [i, node] of (flow.nodes || []).entries()) {
      if (node.disabled) continue;
      if (signal?.aborted) throw new Error("已取消");
      record({ type: "node-start", node: node.id, index: i, label: node.title || NODE_TYPES[node.type]?.label });
      try {
        const out = await runNode(node, vars, ctx);
        const varName = node.out ?? NODE_TYPES[node.type]?.out;
        if (varName && out !== undefined) vars[varName] = out;
        if (out !== undefined) lastOutput = out;
        record({ type: "node-done", node: node.id, index: i, var: varName, preview: stringify(out).slice(0, 1500) });
      } catch (e) {
        if (e instanceof StopFlow) {
          run.status = "stopped";
          record({ type: "stopped", node: node.id, index: i });
          break;
        }
        record({ type: "node-error", node: node.id, index: i, message: e.message });
        throw e;
      }
    }
    if (run.status === "running") run.status = "success";
    run.output = stringify(lastOutput).slice(0, 200000);
    record({ type: "done", status: run.status, output: run.output, files: run.files, usage: { ...(currentUsage() || {}) } });
  } catch (e) {
    run.status = "error";
    run.error = e.message;
    record({ type: "error", message: e.message });
  } finally {
    run.finishedAt = new Date().toISOString();
    const runs = load("runs", []);
    runs.unshift({ ...run, output: run.output?.slice(0, 50000) });
    save("runs", runs.slice(0, 100));
  }
  return run;
}

// ---------- 工作流儲存 ----------
export function listFlows() {
  return load("flows", []);
}
export function getFlow(id) {
  return listFlows().find((f) => f.id === id);
}
export function saveFlow(flow) {
  const flows = listFlows();
  const f = { ...flow, id: flow.id || newId(), updatedAt: new Date().toISOString() };
  f.nodes = (f.nodes || []).map((n, i) => ({ ...n, id: n.id || `n${i + 1}` }));
  const i = flows.findIndex((x) => x.id === f.id);
  // 編輯器送來的副本可能帶著較舊的排程時間，保留較新的那個，避免重複執行
  const prevRun = i >= 0 ? flows[i].lastScheduledRun : undefined;
  if (prevRun && (!f.lastScheduledRun || prevRun > f.lastScheduledRun)) f.lastScheduledRun = prevRun;
  if (i >= 0) flows[i] = f;
  else flows.unshift(f);
  save("flows", flows);
  return f;
}
export function deleteFlow(id) {
  save("flows", listFlows().filter((f) => f.id !== id));
}

// ---------- 排程 ----------
/** schedule: { enabled, mode: "interval"|"daily", minutes, time: "HH:MM", input } */
export function isDue(flow, now = new Date()) {
  const s = flow.schedule;
  if (!s?.enabled) return false;
  const last = flow.lastScheduledRun ? new Date(flow.lastScheduledRun) : null;
  if (s.mode === "daily") {
    const [h, m] = String(s.time || "09:00").split(":").map(Number);
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    return now >= target && (!last || last < target);
  }
  const mins = Math.max(5, Number(s.minutes) || 60);
  return !last || now - last >= mins * 60000;
}

export function startScheduler(getSettingsFn, log = console.log) {
  const running = new Set();
  const tick = async () => {
    for (const flow of listFlows()) {
      if (running.has(flow.id) || !isDue(flow)) continue;
      running.add(flow.id);
      saveFlow({ ...flow, lastScheduledRun: new Date().toISOString() });
      log(`[排程] 執行「${flow.name}」`);
      runFlow(flow, { input: flow.schedule.input || "", settings: getSettingsFn(), trigger: "schedule" })
        .then((r) => log(`[排程] 「${flow.name}」${r.status}${r.error ? "：" + r.error : ""}`))
        .finally(() => running.delete(flow.id));
    }
  };
  const t = setInterval(tick, 30000);
  setTimeout(tick, 3000);
  return () => clearInterval(t);
}

// ---------- 範本 ----------
export const TEMPLATES = [
  {
    name: "🌏 外文文章 → 繁中翻譯 + 摘要",
    description: "貼上英文（或任何語言）文章網址，自動擷取正文、翻成繁體中文、產生摘要，存成 Markdown 檔。",
    inputLabel: "文章網址",
    inputPlaceholder: "https://example.com/blog/post",
    nodes: [
      { id: "n1", type: "fetch_url", url: "{{input}}", mode: "article", out: "page" },
      { id: "n2", type: "translate", source: "{{page}}", target: "zh-TW", out: "translated" },
      { id: "n3", type: "summarize", source: "{{page}}", style: "三到五點重點條列，使用繁體中文", out: "summary" },
      { id: "n4", type: "set", value: "# {{page.title}}\n\n原文：{{page.url}}\n\n## 摘要\n\n{{summary}}\n\n## 全文翻譯\n\n{{translated}}", out: "text" },
      { id: "n5", type: "save_file", source: "{{text}}", format: "md", filename: "翻譯-{{today}}", out: "file" },
    ],
  },
  {
    name: "📑 論文 PDF → 繁中翻譯 + 摘要",
    description: "適用於需要訂閱、無法直接擷取的期刊論文：先在瀏覽器下載 PDF，上傳到「📁 檔案」，在第 1 個節點選擇檔案後執行。",
    inputLabel: "摘要重點（選填）",
    inputPlaceholder: "例如：著重研究方法與數值結果",
    nodes: [
      { id: "n1", type: "read_file", fileId: "", out: "doc" },
      { id: "n2", type: "summarize", source: "{{doc}}", style: "學術摘要（研究目的、方法、結果、結論）{{input}}", out: "summary" },
      { id: "n3", type: "translate", source: "{{doc}}", target: "zh-TW", out: "translated" },
      { id: "n4", type: "set", value: "# {{doc.name}}\n\n## 摘要\n\n{{summary}}\n\n## 全文翻譯\n\n{{translated}}", out: "text" },
      { id: "n5", type: "save_file", source: "{{text}}", format: "md", filename: "論文翻譯-{{today}}", out: "file" },
    ],
  },
  {
    name: "📰 多網址每日簡報",
    description: "每行一個網址（新聞、部落格、公告頁），逐一擷取並摘要，最後整合成一份簡報並推送到 Slack / Discord。可設定每天自動執行。",
    inputLabel: "網址清單（每行一個）",
    inputPlaceholder: "https://news.example.com/a\nhttps://blog.example.com/b",
    nodes: [
      { id: "n1", type: "llm_each", list: "{{input}}", fetch: true, prompt: "用繁體中文以 2-3 句話摘要這篇內容，第一句寫出最重要的資訊：\n\n{{item}}", out: "items" },
      { id: "n2", type: "llm", prompt: "以下是今天收集的各篇摘要，請整合成一份「{{today}} 每日簡報」：開頭三行總結今天最重要的事，接著分類列出各則重點並附原始連結。\n\n{{items}}", out: "ai" },
      { id: "n3", type: "save_file", source: "{{ai}}", format: "md", filename: "每日簡報-{{today}}", out: "file" },
      { id: "n4", type: "webhook", url: "", message: "{{ai}}", disabled: true },
    ],
  },
  {
    name: "🩺 網站健康巡檢 + 異常通知",
    description: "檢測網站的 SSL、安全標頭、SEO、失效連結。分數低於門檻時，由 AI 寫出修正建議並發送通知。適合設成每天自動執行。",
    inputLabel: "網站網址",
    inputPlaceholder: "https://your-site.com",
    nodes: [
      { id: "n1", type: "site_check", url: "{{input}}", out: "check" },
      { id: "n2", type: "save_file", source: "{{check}}", format: "md", filename: "網站檢測-{{check.host}}-{{today}}", out: "file" },
      { id: "n3", type: "condition", left: "{{check.score}}", op: "lt", right: "85" },
      { id: "n4", type: "llm", prompt: "以下是網站檢測報告。請以繁體中文列出最該優先處理的 5 個問題，每個問題附上具體修正方法（例如 Nginx / Apache / Cloudflare 的設定範例）。\n\n{{check}}", out: "ai" },
      { id: "n5", type: "webhook", url: "", message: "⚠️ {{check.host}} 檢測分數 {{check.score}}（{{check.grade}}）\n\n{{check.issues}}", disabled: true },
    ],
  },
  {
    name: "🔔 網頁變動監控",
    description: "定時檢查某個網頁（價格、公告、職缺頁…），內容有變動時由 AI 說明改了什麼並通知你。",
    inputLabel: "要監控的網址",
    inputPlaceholder: "https://example.com/pricing",
    nodes: [
      { id: "n1", type: "fetch_url", url: "{{input}}", mode: "full", out: "page" },
      { id: "n2", type: "set", value: "{{page.markdown}}", out: "text" },
      { id: "n3", type: "condition", left: "{{text}}", op: "changed", right: "" },
      { id: "n4", type: "llm", prompt: "網頁 {{page.url}} 的內容有更新。請用繁體中文簡短說明目前頁面的重點內容，特別是價格、日期、數字等資訊：\n\n{{text}}", out: "ai" },
      { id: "n5", type: "webhook", url: "", message: "🔔 網頁有變動：{{page.url}}\n\n{{ai}}", disabled: true },
    ],
  },
  {
    name: "📊 文件 → Excel 表格",
    description: "從上傳的 PDF / Word（報價單、型錄、報告、名單…）擷取指定欄位，輸出 Excel。",
    inputLabel: "擷取條件（選填）",
    inputPlaceholder: "例如：只要 2024 年以後的項目",
    nodes: [
      { id: "n1", type: "read_file", fileId: "", out: "doc" },
      { id: "n2", type: "extract", source: "{{doc}}", fields: "項目, 數量, 單價, 金額, 備註", instruction: "{{input}}", out: "table" },
      { id: "n3", type: "save_file", source: "{{table}}", format: "xlsx", filename: "擷取結果-{{today}}", out: "file" },
    ],
  },
  {
    name: "📚 網站 → 知識庫",
    description: "爬取整個網站（例如產品說明文件、FAQ），自動存進知識庫，之後就能在「知識庫問答」直接提問。",
    inputLabel: "網站起始網址",
    inputPlaceholder: "https://docs.example.com/",
    nodes: [
      { id: "n1", type: "crawl", url: "{{input}}", maxPages: 20, maxDepth: 2, include: "", out: "site" },
      { id: "n2", type: "kb_add", kbId: "", source: "{{site}}", title: "{{input}}", out: "kbResult" },
    ],
  },
  {
    name: "🔌 API 資料 → AI 分析報告",
    description: "呼叫任何 JSON API（此範例為 GitHub 公開 API），由 AI 解讀資料並產生報告。可換成你自己的內部 API。",
    inputLabel: "GitHub 專案（owner/repo）",
    inputPlaceholder: "nodejs/node",
    nodes: [
      { id: "n1", type: "http", method: "GET", url: "https://api.github.com/repos/{{input}}/issues?state=open&per_page=30", headers: "Accept: application/vnd.github+json\nUser-Agent: ai-studio", out: "api" },
      { id: "n2", type: "llm", prompt: "以下是 GitHub 專案 {{input}} 最新的 30 個未關閉 issue（JSON）。請用繁體中文分類整理：主要問題類型、最需要優先處理的 5 個 issue（附連結與理由）、整體觀察。\n\n{{api}}", out: "ai" },
      { id: "n3", type: "save_file", source: "{{ai}}", format: "md", filename: "issue分析-{{today}}", out: "file" },
    ],
  },
];
