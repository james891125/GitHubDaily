import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 測試使用獨立資料夾
process.env.STUDIO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "studio-test-"));
delete process.env.ANTHROPIC_API_KEY;
// 學術 API 指向本機假伺服器（需在載入模組前設定）
const { startScholarMock } = await import("./fixtures.js");
const scholarMock = await startScholarMock();
process.env.SCHOLAR_ELSEVIER_BASE = scholarMock.url + "/els";
process.env.SCHOLAR_CROSSREF_BASE = scholarMock.url + "/cr";
process.env.SCHOLAR_OPENALEX_BASE = scholarMock.url + "/oa";

const { startSite, startMockLlm, makePdf } = await import("./fixtures.js");
const store = await import("../lib/store.js");
const docs = await import("../lib/docs.js");
const web = await import("../lib/web.js");
const kb = await import("../lib/kb.js");
const doctools = await import("../lib/doctools.js");
const flow = await import("../lib/flow.js");
const ExcelJS = (await import("exceljs")).default;

let site, llm;
before(async () => {
  site = await startSite();
  llm = await startMockLlm();
  store.saveSettings({ provider: "openai", openaiBase: llm.base, openaiModel: "mock", openaiKey: "test-key" });
});
after(() => {
  scholarMock.server.close();
  site.server.close();
  llm.server.close();
});

test("設定：金鑰遮罩、遮罩值不會覆蓋原金鑰", () => {
  assert.match(store.publicSettings().openaiKey, /•/);
  store.saveSettings({ openaiKey: store.publicSettings().openaiKey });
  assert.equal(store.getSettings().openaiKey, "test-key");
});

test("文件：PDF 擷取文字", async () => {
  const r = await docs.parseDocument("a.pdf", makePdf(["Hello PDF world", "Second line 123"]));
  assert.match(r.text, /Hello PDF world/);
  assert.match(r.text, /Second line 123/);
  assert.equal(r.pages, 1);
});

test("文件：Excel 讀寫來回", async () => {
  const buf = await doctools.toXlsx({ columns: ["名稱", "數量"], rows: [{ 名稱: "蘋果", 數量: "3" }] });
  const r = await docs.parseDocument("x.xlsx", buf);
  assert.match(r.text, /\| 名稱 \| 數量 \|/);
  assert.match(r.text, /蘋果/);
});

test("文件：不支援的格式有明確訊息", async () => {
  await assert.rejects(docs.parseDocument("a.exe", Buffer.from("x")), /不支援/);
});

test("文件：切塊不遺漏內容", () => {
  const text = Array.from({ length: 30 }, (_, i) => `## 第${i}節\n\n` + `內容${i}。`.repeat(40)).join("\n\n");
  const chunks = docs.chunkText(text, { maxChars: 500 });
  assert.ok(chunks.length > 10);
  for (let i = 0; i < 30; i++) assert.ok(chunks.some((c) => c.text.includes(`內容${i}。`)), `missing 內容${i}`);
  assert.ok(chunks.every((c) => c.text.length <= 700));
});

test("網頁：擷取正文並轉 Markdown（含表格）", async () => {
  const p = await web.scrapePage(site.url + "/");
  assert.equal(p.title, "測試商店");
  assert.match(p.markdown, /退貨期限為七天/);
  const t = await web.scrapePage(site.url + "/products", { mode: "full" });
  assert.match(t.markdown, /\| 烏龍茶 \| 350 \|/);
});

test("網頁：同網域爬取，不跟外站，記錄失敗頁", async () => {
  const r = await web.crawlSite(site.url + "/", { maxPages: 10, delayMs: 0 });
  const urls = r.pages.map((p) => new URL(p.url).pathname).sort();
  assert.deepEqual(urls, ["/", "/about", "/products"]);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].url, /missing/);
});

test("網站檢測：抓出失效連結、缺少的標頭並評分", async () => {
  const steps = [];
  const r = await web.checkSite(site.url, { onStep: (s) => steps.push(s) });
  assert.deepEqual(steps, ["dns", "http", "security", "ssl", "seo", "files", "links", "score"]);
  assert.equal(r.http.status, 200);
  assert.ok(r.links.broken.some((b) => b.url.endsWith("/missing") && b.status === 404));
  assert.equal(r.robots.exists, true);
  assert.equal(r.sitemap.exists, false);
  assert.ok(r.score.issues.some((i) => /失效/.test(i.msg)));
  assert.ok(r.score.issues.some((i) => /HTTPS/.test(i.msg)));
  assert.ok(r.score.score < 90);
  assert.match(web.reportToMarkdown(r), /網站檢測報告/);
});

test("知識庫：BM25 找到正確段落，問答附出處", async () => {
  const k = kb.createKb("測試");
  kb.addDocument(k.id, { title: "退貨政策", text: "## 退貨\n\n商品到貨後七天內可申請退貨，需保持包裝完整。" });
  kb.addDocument(k.id, { title: "公司簡介", text: "我們成立於 2010 年，總部位於台北市信義區。" });
  const hits = kb.search(kb.getKb(k.id), "退貨要幾天內申請？");
  assert.equal(hits[0].title, "退貨政策");
  const r = await kb.ask(k.id, "退貨期限？");
  assert.match(r.answer, /七天 \[1\]/);
  assert.equal(r.sources[0].title, "退貨政策");
  const r2 = await kb.ask(k.id, "老闆叫什麼名字？");
  assert.match(r2.answer, /沒有相關資訊/);
  kb.deleteKb(k.id);
  assert.equal(kb.listKbs().find((x) => x.id === k.id), undefined);
});

test("文件工具：擷取表格 → CSV / Excel", async () => {
  const t = await doctools.extractTable("烏龍茶 350 元，紅茶 280 元", { fields: "品名, 價格" });
  assert.deepEqual(t.columns, ["品名", "價格"]);
  assert.equal(t.rows.length, 2);
  const csv = doctools.toCsv(t);
  assert.ok(csv.startsWith("﻿品名,價格"));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await doctools.toXlsx(t));
  assert.equal(wb.worksheets[0].getCell("A2").value, "烏龍茶");
});

test("模板：變數、欄位路徑、物件轉文字", () => {
  const vars = { input: "x", page: { __type: "page", title: "T", url: "u", markdown: "M" }, check: { score: 70 } };
  assert.equal(flow.render("{{input}}-{{page.title}}-{{check.score}}-{{nope}}", vars), "x-T-70-");
  assert.match(flow.render("{{page}}", vars), /# T\n來源：u\n\nM/);
});

test("工作流：擷取 → 翻譯 → 組合 → 輸出 Markdown 檔", async () => {
  const tpl = structuredClone(flow.TEMPLATES[0]);
  const events = [];
  const run = await flow.runFlow(tpl, { input: site.url + "/about", emit: (e) => events.push(e) });
  assert.equal(run.status, "success", run.error);
  assert.equal(run.files.length, 1);
  const saved = fs.readFileSync(store.outputPath(run.files[0].name), "utf8");
  assert.match(saved, /# 關於我們/);
  assert.match(saved, /【譯文】/);
  assert.ok(events.filter((e) => e.type === "node-done").length === 5);
});

test("工作流：網站巡檢的條件判斷會停止後續節點", async () => {
  const f = {
    id: "t-check",
    name: "巡檢",
    nodes: [
      { id: "n1", type: "site_check", url: "{{input}}", out: "check" },
      { id: "n2", type: "condition", left: "{{check.score}}", op: "gt", right: "100" },
      { id: "n3", type: "llm", prompt: "不該執行", out: "ai" },
    ],
  };
  const run = await flow.runFlow(f, { input: site.url });
  assert.equal(run.status, "stopped");
  assert.ok(!llm.calls.some((c) => c.includes("不該執行")));
});

test("工作流：網頁變動監控（changed 條件）", async () => {
  const f = {
    id: "t-monitor",
    name: "監控",
    nodes: [
      { id: "n1", type: "fetch_url", url: site.url + "/changing", mode: "full", out: "page" },
      { id: "n2", type: "set", value: "{{page.markdown}}", out: "text" },
      { id: "n3", type: "condition", left: "{{text}}", op: "changed", right: "" },
      { id: "n4", type: "set", value: "有變動", out: "msg" },
    ],
  };
  assert.equal((await flow.runFlow(f, {})).status, "stopped"); // 第一次只記錄基準
  assert.equal((await flow.runFlow(f, {})).status, "success"); // 內容變了
});

test("工作流：讀取檔案 → 擷取表格 → Excel；逐項處理；存入知識庫", async () => {
  const file = await flow.addFile("price.txt", Buffer.from("烏龍茶 350 元\n紅茶 280 元"));
  const k = kb.createKb("工作流測試");
  const f = {
    id: "t-mix",
    name: "綜合",
    nodes: [
      { id: "n1", type: "read_file", fileId: file.id, out: "doc" },
      { id: "n2", type: "extract", source: "{{doc}}", fields: "品名, 價格", out: "table" },
      { id: "n3", type: "save_file", source: "{{table}}", format: "xlsx", filename: "價目", out: "file" },
      { id: "n4", type: "llm_each", list: "{{table}}", prompt: "介紹：{{item}}", out: "items" },
      { id: "n5", type: "crawl", url: site.url, maxPages: 3, out: "site" },
      { id: "n6", type: "kb_add", kbId: k.id, source: "{{site}}", out: "kbResult" },
      { id: "n7", type: "http", method: "GET", url: site.url + "/robots.txt", out: "api" },
    ],
  };
  const run = await flow.runFlow(f, {});
  assert.equal(run.status, "success", run.error);
  assert.ok(run.files[0].name.endsWith("價目.xlsx"));
  assert.ok(llm.calls.some((c) => c.includes("介紹：品名：烏龍茶")));
  assert.equal(kb.getKb(k.id).docs.length, 3);
  assert.match(run.output, /User-agent/);
});

test("工作流：錯誤節點會回報並標記失敗", async () => {
  const run = await flow.runFlow({ id: "t-err", name: "錯", nodes: [{ id: "n1", type: "read_file", fileId: "nope" }] }, {});
  assert.equal(run.status, "error");
  assert.match(run.error, /找不到檔案/);
});

test("排程：每日與間隔判斷", () => {
  const at = (h, m) => {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d;
  };
  const daily = { schedule: { enabled: true, mode: "daily", time: "09:00" } };
  assert.equal(flow.isDue(daily, at(8, 59)), false);
  assert.equal(flow.isDue(daily, at(9, 1)), true);
  assert.equal(flow.isDue({ ...daily, lastScheduledRun: at(9, 1).toISOString() }, at(15, 0)), false);
  const iv = { schedule: { enabled: true, mode: "interval", minutes: 30 }, lastScheduledRun: new Date(Date.now() - 10 * 60000).toISOString() };
  assert.equal(flow.isDue(iv), false);
  assert.equal(flow.isDue({ ...iv, lastScheduledRun: new Date(Date.now() - 31 * 60000).toISOString() }), true);
  assert.equal(flow.isDue({ schedule: { enabled: false } }), false);
});

test("所有範本的節點類型都存在", () => {
  for (const t of flow.TEMPLATES) for (const n of t.nodes) assert.ok(flow.NODE_TYPES[n.type], `${t.name}: ${n.type}`);
});

test("儲存工作流不會覆蓋較新的排程時間", () => {
  const f = flow.saveFlow({ name: "s", nodes: [], lastScheduledRun: "2026-01-02T00:00:00.000Z" });
  flow.saveFlow({ ...f, lastScheduledRun: undefined, name: "s2" });
  const g = flow.getFlow(f.id);
  assert.equal(g.name, "s2");
  assert.equal(g.lastScheduledRun, "2026-01-02T00:00:00.000Z");
});

test("OpenAI 相容：自動切換 max_tokens / max_completion_tokens", async () => {
  const http = await import("node:http");
  const { postChatCompletion } = await import("../lib/llm.js");
  // 模擬 OpenAI 新模型：只接受 max_completion_tokens
  const seen = [];
  const strict = http.createServer(async (req, res) => {
    let b = "";
    for await (const c of req) b += c;
    const body = JSON.parse(b);
    seen.push(Object.keys(body).find((k) => k.startsWith("max_")));
    if ("max_tokens" in body) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", code: "unsupported_parameter" } }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise((r) => strict.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${strict.address().port}/v1`;
  const r1 = await postChatCompletion({ base, key: "k", model: "gpt-5", messages: [{ role: "user", content: "hi" }], maxTokens: 100 });
  assert.equal(r1.status, 200);
  assert.deepEqual(seen, ["max_tokens", "max_completion_tokens"]);
  // 第二次直接用記住的參數，不再先失敗
  await postChatCompletion({ base, key: "k", model: "gpt-5", messages: [{ role: "user", content: "hi" }], maxTokens: 100 });
  assert.deepEqual(seen.slice(2), ["max_completion_tokens"]);
  strict.close();
});

const scholar = await import("../lib/scholar.js");

test("論文：辨識 PII / DOI", () => {
  assert.deepEqual(scholar.identify("https://www.sciencedirect.com/science/article/pii/S0955799717306604"), { doi: null, pii: "S0955799717306604" });
  assert.equal(scholar.identify("https://doi.org/10.1016/j.enganabound.2017.10.009").doi, "10.1016/j.enganabound.2017.10.009");
  assert.equal(scholar.identify("https://example.com/blog"), null);
});

test("論文：沒有 Elsevier 金鑰 → Crossref 找 DOI → OpenAlex 開放取用 PDF 全文", async () => {
  store.saveSettings({ elsevierKey: "" });
  const logs = [];
  const p = await scholar.fetchPaper("https://www.sciencedirect.com/science/article/pii/S0955799717306604", { log: (m) => logs.push(m) });
  assert.equal(p.title, "A meshless method for Laplace problems");
  assert.equal(p.scholar.fullText, true);
  assert.match(p.markdown, /Open access full text body/);
  assert.ok(logs.some((l) => l.includes("Crossref")));
});

test("論文：沒有開放取用 → 只取得摘要並給出明確提示", async () => {
  store.saveSettings({ elsevierKey: "" });
  const p = await scholar.fetchPaper("https://doi.org/10.9999/closed.1");
  assert.equal(p.scholar.fullText, false);
  assert.match(p.markdown, /We study closed things/);
  assert.match(p.markdown, /只取得摘要/);
});

test("論文：有 Elsevier 金鑰時取得全文", async () => {
  store.saveSettings({ elsevierKey: "els-key" });
  const p = await scholar.fetchPaper("https://www.sciencedirect.com/science/article/pii/S0955799717306604");
  assert.equal(p.scholar.source, "Elsevier API");
  assert.match(p.markdown, /Elsevier full text/);
  assert.equal(scholarMock.lastElsKey(), "els-key");
  store.saveSettings({ elsevierKey: "" });
});

test("網頁 403：一般網站給出可行的解法說明", async () => {
  await assert.rejects(web.scrapePage(scholarMock.url + "/blocked"), /HTTP 403：.*上傳到「📁 檔案」/);
});
