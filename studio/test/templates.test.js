// 整合測試：啟動真正的伺服器，透過 HTTP API 執行「每一個範本」與每一項工具，
// 並在多種 AI 供應商／模式下重複執行。所有外部服務都由 test/world.js 模擬。
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { startWorld } from "./world.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FILES = path.join(here, "files");
let world, server, BASE, dataDir;

before(async () => {
  world = await startWorld();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-it-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  BASE = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(here, "..", "server.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      STUDIO_DATA_DIR: dataDir,
      ANTHROPIC_BASE_URL: world.claude.base,
      ANTHROPIC_API_KEY: "",
      SCHOLAR_ELSEVIER_BASE: world.scholar.url + "/els",
      SCHOLAR_CROSSREF_BASE: world.scholar.url + "/cr",
      SCHOLAR_OPENALEX_BASE: world.scholar.url + "/oa",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(BASE + "/api/meta");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("伺服器啟動失敗：" + log);
});
after(() => {
  server?.kill();
  world?.close();
});

// ---------- 小工具 ----------
async function api(p, body, method) {
  const res = await fetch(BASE + p, {
    method: method || (body ? "POST" : "GET"),
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error), { status: res.status });
  return data;
}
async function stream(p, body) {
  const res = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
const last = (events, type) => events.filter((e) => e.type === type).at(-1);
async function upload(name) {
  return api("/api/files", { name, data: fs.readFileSync(path.join(FILES, name)).toString("base64") });
}
async function download(file) {
  const res = await fetch(BASE + file.url);
  assert.equal(res.status, 200, `下載 ${file.name}`);
  return Buffer.from(await res.arrayBuffer());
}
/** 輸出內容不得出現程式錯誤的痕跡 */
function assertClean(text, where) {
  for (const bad of ["undefined", "[object Object]", "{{", "NaN"]) assert.ok(!String(text).includes(bad), `${where} 出現「${bad}」：${String(text).slice(0, 300)}`);
}
async function runTemplate(index, { input = "", patch = (f) => f } = {}) {
  const meta = await api("/api/meta");
  const tpl = structuredClone(meta.templates[index]);
  const flow = await api("/api/flows", patch(tpl));
  const events = await stream("/api/flows/run", { id: flow.id, input });
  const done = last(events, "done");
  const error = last(events, "error");
  return { flow, events, done, error, status: done?.status || "error", files: done?.files || [] };
}
const tplIndex = async (name) => (await api("/api/meta")).templates.findIndex((t) => t.name.includes(name));
const setNode = (type, fields) => (f) => {
  f.nodes.filter((n) => n.type === type).forEach((n) => Object.assign(n, fields));
  return f;
};

// ---------- 各 AI 供應商設定 ----------
const PROVIDERS = {
  "OpenAI 相容（一般）": { provider: "openai", openaiBase: () => world.openai.base, openaiModel: "mock", openaiKey: "sk-test" },
  "OpenAI 新模型（只收 max_completion_tokens）": { provider: "openai", openaiBase: () => world.openai.base, openaiModel: "strict", openaiKey: "sk-test" },
  "OpenAI 推理模型（含空白片段）": { provider: "openai", openaiBase: () => world.openai.base, openaiModel: "reasoning", openaiKey: "sk-test" },
  "舊版相容服務（只收 max_tokens）": { provider: "openai", openaiBase: () => world.openai.base, openaiModel: "legacy", openaiKey: "sk-test" },
  "Claude Opus 5.5": { provider: "anthropic", anthropicKey: "sk-ant-test", claudeModel: "claude-opus-5-5" },
  "Claude Haiku 5.5": { provider: "anthropic", anthropicKey: "sk-ant-test", claudeModel: "claude-haiku-5-5", effort: "low" },
};
async function useProvider(name) {
  const p = PROVIDERS[name];
  const s = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === "function" ? v() : v]));
  await api("/api/settings", { webhookUrl: world.webhook.url, cacheDays: 0, usageMode: "economy", effort: "", ...s });
}

// ================= 每個供應商 × 每個範本 =================
for (const providerName of Object.keys(PROVIDERS)) {
  describe(`範本全測（${providerName}）`, () => {
    before(() => useProvider(providerName));

    test("連線測試", async () => {
      const r = await api("/api/settings/test", {});
      assert.equal(r.ok, true, r.error);
      assert.match(r.text, /連線成功/);
    });

    test("🌏 外文文章 → 繁中翻譯 + 摘要", async () => {
      const r = await runTemplate(await tplIndex("外文文章"), { input: world.site.url + "/en" });
      assert.equal(r.status, "success", r.error?.message);
      assert.equal(r.files.length, 1);
      const md = (await download(r.files[0])).toString("utf8");
      assert.match(md, /^# A Guide to Oolong Tea/);
      assert.match(md, /原文：http/);
      assert.match(md, /## 摘要/);
      assert.match(md, /【譯文】/);
      assertClean(md, "翻譯結果檔");
    });

    test("📑 論文 PDF → 繁中翻譯 + 摘要（中文 PDF）", async () => {
      const f = await upload("中文報告.pdf");
      const r = await runTemplate(await tplIndex("論文 PDF"), { input: "", patch: setNode("read_file", { fileId: f.id }) });
      assert.equal(r.status, "success", r.error?.message);
      const md = (await download(r.files[0])).toString("utf8");
      assert.match(md, /^# 中文報告\.pdf/);
      assert.match(md, /【譯文】/);
      assertClean(md, "論文翻譯檔");
    });

    test("📰 多網址每日簡報（含一個被擋的網址）＋ Webhook", async () => {
      const before = world.webhook.received.length;
      const input = [world.site.url + "/news/1", world.site.url + "/news/2", world.site.url + "/blocked"].join("\n");
      const r = await runTemplate(await tplIndex("每日簡報"), { input, patch: setNode("webhook", { disabled: false }) });
      assert.equal(r.status, "success", r.error?.message);
      const logs = r.events.filter((e) => e.type === "log").map((e) => e.message).join("\n");
      assert.match(logs, /失敗 3\/3：HTTP 403/);
      assert.equal(world.webhook.received.length, before + 1);
      const msg = world.webhook.received.at(-1);
      assert.ok(msg.text && msg.content, "Webhook 需同時有 Slack(text) 與 Discord(content) 欄位");
      assertClean(msg.text, "Webhook 訊息");
      const md = (await download(r.files[0])).toString("utf8");
      assertClean(md, "每日簡報檔");
    });

    test("🩺 網站健康巡檢 + 異常通知", async () => {
      const before = world.webhook.received.length;
      const r = await runTemplate(await tplIndex("健康巡檢"), { input: world.site.url, patch: setNode("webhook", { disabled: false }) });
      assert.equal(r.status, "success", r.error?.message);
      const report = (await download(r.files[0])).toString("utf8");
      assert.match(report, /網站檢測報告/);
      assert.match(report, /失效/);
      assertClean(report, "巡檢報告");
      assert.equal(world.webhook.received.length, before + 1);
      assert.match(world.webhook.received.at(-1).text, /檢測分數 \d+（[A-F]）/);
      assertClean(world.webhook.received.at(-1).text, "巡檢通知");
    });

    test("🔔 網頁變動監控：第一次記錄、第二次偵測到變動並通知", async () => {
      const idx = await tplIndex("變動監控");
      const meta = await api("/api/meta");
      const tpl = structuredClone(meta.templates[idx]);
      tpl.nodes.find((n) => n.type === "webhook").disabled = false;
      const flow = await api("/api/flows", tpl);
      const before = world.webhook.received.length;
      const e1 = await stream("/api/flows/run", { id: flow.id, input: world.site.url + "/changing" });
      assert.equal(last(e1, "done").status, "stopped");
      const e2 = await stream("/api/flows/run", { id: flow.id, input: world.site.url + "/changing" });
      assert.equal(last(e2, "done").status, "success", last(e2, "error")?.message);
      assert.equal(world.webhook.received.length, before + 1);
      assert.match(world.webhook.received.at(-1).text, /網頁有變動/);
    });

    test("📊 文件 → Excel 表格（Word 報價單）", async () => {
      const f = await upload("報價單.docx");
      const r = await runTemplate(await tplIndex("Excel"), { patch: setNode("read_file", { fileId: f.id }) });
      assert.equal(r.status, "success", r.error?.message);
      assert.ok(r.files[0].name.endsWith(".xlsx"));
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await download(r.files[0]));
      const ws = wb.worksheets[0];
      assert.equal(ws.getCell("A1").value, "項目");
      assert.equal(ws.getCell("A2").value, "伺服器");
      assert.equal(ws.rowCount, 3);
    });

    test("📚 網站 → 知識庫，然後提問", async () => {
      const kb = await api("/api/kb", { name: "說明文件 " + providerName });
      const r = await runTemplate(await tplIndex("知識庫"), {
        input: world.site.url + "/docs/",
        patch: (f) => {
          setNode("kb_add", { kbId: kb.id })(f);
          setNode("crawl", { include: "/docs/" })(f);
          return f;
        },
      });
      assert.equal(r.status, "success", r.error?.message);
      const detail = await api("/api/kb/detail?id=" + kb.id);
      assert.equal(detail.docs.length, 3, "應只爬 /docs/ 底下 3 頁：" + detail.docs.map((d) => d.source).join(", "));
      const ev = await stream("/api/kb/ask", { kbId: kb.id, question: "忘記密碼怎麼辦？" });
      const done = last(ev, "done");
      assert.ok(done, last(ev, "error")?.message);
      assert.match(done.answer, /\[1\]/);
      assert.equal(done.sources[0].title, "常見問題");
    });

    test("🔌 API 資料 → AI 分析報告（API 網址換成本機模擬）", async () => {
      const r = await runTemplate(await tplIndex("API 資料"), {
        input: "demo/repo",
        patch: setNode("http", { url: world.site.url + "/api/issues?repo={{input}}" }),
      });
      assert.equal(r.status, "success", r.error?.message);
      const md = (await download(r.files[0])).toString("utf8");
      assertClean(md, "API 報告");
      // 確認 API 的 JSON 有傳給 AI
      const doneNode = r.events.find((e) => e.type === "node-done" && e.var === "api");
      assert.match(doneNode.preview, /登入頁在 Safari/);
    });
  });
}

// ================= 範本缺少必要設定時，要有清楚的錯誤訊息 =================
describe("範本未完成設定時的錯誤訊息", () => {
  before(() => useProvider("OpenAI 相容（一般）"));
  test("所有範本直接執行（不選檔案／知識庫、不填輸入）都不會當機，且錯誤可理解", async () => {
    const meta = await api("/api/meta");
    for (let i = 0; i < meta.templates.length; i++) {
      const r = await runTemplate(i, { input: "" });
      if (r.status === "error") {
        const msg = r.error.message;
        assert.ok(/[一-鿿]/.test(msg), `${meta.templates[i].name} 的錯誤訊息應為中文說明：${msg}`);
        assert.ok(!/TypeError|ReferenceError|Cannot read|is not a function|undefined/.test(msg), `${meta.templates[i].name} 出現程式錯誤：${msg}`);
      }
    }
  });
});

// ================= 文件工具：每種檔案格式 =================
describe("文件工具 × 各種檔案", () => {
  before(() => useProvider("OpenAI 相容（一般）"));
  const expectText = {
    "中文報告.pdf": /營收成長百分之二十三/,
    "會議紀錄.docx": /# 會議紀錄/,
    "報價單.docx": /\| 伺服器 \| 2 \| 45000 \|/,
    "庫存.xlsx": /\| 鍵盤 \| 12 \|/,
    "名單.csv": /王小明,0912-345-678/,
    "筆記.md": /## 進度/,
    "說明.txt": /十四天/,
    "頁面.html": /# 停機公告/,
  };
  for (const [name, re] of Object.entries(expectText)) {
    test(`轉 Markdown：${name}`, async () => {
      const f = await upload(name);
      const r = await api("/api/doc/convert", { fileId: f.id });
      assert.match(r.text, re);
      assert.ok(!r.text.startsWith("﻿"), "不應保留 BOM");
      const dl = (await download(r.files[0])).toString("utf8");
      assert.match(dl, re);
    });
  }
  test("掃描型 PDF：可以上傳但標記為需文字辨識；直接轉文字時提示改用文字辨識服務", async () => {
    const f = await upload("掃描檔.pdf");
    assert.equal(f.needsOcr, true);
    await assert.rejects(api("/api/doc/convert", { fileId: f.id }), /掃描文件文字辨識/);
  });
  test("損毀的檔案（副檔名是 .docx 但內容不是）：清楚的錯誤，且不是伺服器錯誤 500", async () => {
    const res = await fetch(BASE + "/api/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "壞掉.docx", data: Buffer.from("這不是 Word 檔").toString("base64") }) });
    assert.equal(res.status, 422);
    assert.match((await res.json()).error, /無法讀取「壞掉\.docx」/);
  });
  test("空白檔案：清楚的錯誤", async () => {
    await assert.rejects(upload("空白.txt"), /沒有|空/);
  });
  test("翻譯、摘要、擷取表格（PDF / CSV / 貼上文字 / 網址）", async () => {
    const pdf = await upload("中文報告.pdf");
    let ev = await stream("/api/doc/translate", { fileId: pdf.id, target: "en" });
    assert.match(last(ev, "done").output, /【譯文】/);
    ev = await stream("/api/doc/summarize", { text: "會議決議：下週三前完成報價。".repeat(30), style: "會議紀錄（決議與待辦）", length: "簡短" });
    assert.match(last(ev, "done").output, /AI 回覆/);
    const csv = await upload("名單.csv");
    ev = await stream("/api/doc/extract", { fileId: csv.id, fields: "姓名, 電話" });
    assert.ok(last(ev, "done"), last(ev, "error")?.message);
    assert.equal(last(ev, "done").files.length, 2);
    ev = await stream("/api/doc/extract", { url: world.site.url + "/products", fields: "品名, 價格" });
    assert.equal(last(ev, "done").table.rows[0].品名, "烏龍茶");
  });
  test("非常長的文件：分段數合理（不會切太碎浪費呼叫），每段都有處理", async () => {
    const text = Array.from({ length: 40 }, (_, i) => `## 第 ${i + 1} 章\n\n` + `第${i + 1}章的內容。`.repeat(60)).join("\n\n");
    const before = world.openai.calls.length;
    const ev = await stream("/api/doc/translate", { text, target: "zh-TW" });
    const progress = ev.filter((e) => e.type === "progress");
    const calls = world.openai.calls.length - before;
    assert.equal(progress.at(-1).done, progress.at(-1).total);
    assert.equal(calls, progress.at(-1).total, "每段剛好一次呼叫");
    assert.ok(calls <= Math.ceil(text.length / 5000), `${text.length} 字不應超過 ${Math.ceil(text.length / 5000)} 次呼叫，實際 ${calls}`);
    // 每一章都要出現在送出的內容中
    const sent = world.openai.calls.slice(before).map((c) => c.messages.at(-1).content).join("");
    for (let i = 1; i <= 40; i++) assert.ok(sent.includes(`第 ${i} 章`), `第 ${i} 章沒有送去翻譯`);
  });
});

// ================= 網站工具：各種真實網站狀況 =================
describe("網頁擷取 × 真實網站狀況", () => {
  const cases = {
    "/big5": { re: /圖書館將於十二月一日/, title: "繁體中文公告" },
    "/big5-meta": { re: /每週日凌晨進行維護/ },
    "/gzip": { re: /gzip 壓縮傳送/ },
    "/redirect": { re: /成立於 2010 年/ },
    "/paper.pdf": { re: /Accuracy reached 97 percent/ },
    "/zh.pdf": { re: /營收成長百分之二十三/ },
    "/quote.docx": { re: /\| 伺服器 \| 2 \| 45000 \|/ },
    "/download": { re: /Attachment download content/ },
    "/api/issues": { re: /登入頁在 Safari/ },
  };
  for (const [p, { re, title }] of Object.entries(cases)) {
    test(`擷取 ${p}`, async () => {
      const r = await api("/api/web/scrape", { url: world.site.url + p });
      assert.match(r.markdown, re);
      if (title) assert.equal(r.title, title);
      assertClean(r.markdown, p);
    });
  }
  test("被擋（403）、限流（429）、伺服器錯誤（500）、找不到（404）、無法連線、網址打錯：都有中文說明", async () => {
    for (const [p, re] of [["/blocked", /拒絕程式直接存取/], ["/ratelimited", /429/], ["/server-error", /500/], ["/nope", /404/]]) {
      await assert.rejects(api("/api/web/scrape", { url: world.site.url + p }), re);
    }
    await assert.rejects(api("/api/web/scrape", { url: "http://127.0.0.1:1/" }), /無法連線/);
    await assert.rejects(api("/api/web/scrape", { url: "" }), /請輸入網址/);
    await assert.rejects(api("/api/web/scrape", { url: "ht!tp://bad url" }), /網址/);
  });
  test("只有 JavaScript 才有內容的網頁：提示改用其他方式", async () => {
    await assert.rejects(api("/api/web/scrape", { url: world.site.url + "/spa" }), /JavaScript/);
  });
  test("論文網址（DOI）走學術 API", async () => {
    await api("/api/settings", { elsevierKey: "" });
    const r = await api("/api/web/scrape", { url: "https://doi.org/10.1016/j.enganabound.2017.10.009" });
    assert.match(r.markdown, /A meshless method for Laplace problems/);
  });
  test("爬取網站：限制範圍、跳過外站、記錄失敗頁、可存入知識庫", async () => {
    const kb = await api("/api/kb", { name: "爬蟲測試" });
    const ev = await stream("/api/web/crawl", { url: world.site.url + "/", maxPages: 10, maxDepth: 2, kbId: kb.id });
    const done = last(ev, "done");
    assert.ok(done, last(ev, "error")?.message);
    assert.deepEqual(ev.filter((e) => e.type === "page").map((e) => new URL(e.url).pathname).sort(), ["/", "/about", "/products"]);
    assert.ok(done.errors.some((e) => e.url.endsWith("/missing")));
    assert.ok(!ev.some((e) => e.type === "page" && e.url.includes("other.example")));
    assert.equal(done.kbResult.added, done.pages);
  });
  test("網站檢測：分數、問題清單、可下載報告、AI 建議", async () => {
    await useProvider("Claude Opus 5.5");
    const ev = await stream("/api/web/check", { url: world.site.url });
    const done = last(ev, "done");
    assert.ok(done, last(ev, "error")?.message);
    assert.deepEqual(ev.filter((e) => e.type === "step").map((e) => e.step), ["dns", "http", "security", "ssl", "seo", "files", "links", "score"]);
    assert.ok(done.report.score.score >= 0 && done.report.score.score <= 100);
    assertClean(done.markdown, "檢測報告");
    const adv = await stream("/api/web/advise", { markdown: done.markdown });
    assert.ok(last(adv, "done")?.output, last(adv, "error")?.message);
  });
});

// ================= AI 錯誤情況 =================
describe("AI 發生錯誤時", () => {
  test("金鑰錯誤（Claude / OpenAI）", async () => {
    await api("/api/settings", { provider: "anthropic", anthropicKey: "sk-ant-wrong" });
    let r = await api("/api/settings/test", {});
    assert.equal(r.ok, false);
    assert.match(r.error, /Key 無效/);
    await api("/api/settings", { provider: "openai", openaiKey: "", openaiBase: world.openai.base, openaiModel: "mock" });
    r = await api("/api/settings/test", {});
    assert.equal(r.ok, false);
    assert.match(r.error, /API Key/);
  });
  test("限流 429", async () => {
    await api("/api/settings", { provider: "openai", openaiKey: "sk-test", openaiBase: world.openai.base, openaiModel: "ratelimit" });
    const r = await api("/api/settings/test", {});
    assert.match(r.error, /429/);
  });
  test("AI 不照格式回 JSON：擷取表格給出清楚錯誤，工作流標記失敗節點", async () => {
    await api("/api/settings", { provider: "openai", openaiKey: "sk-test", openaiBase: world.openai.base, openaiModel: "badjson" });
    const ev = await stream("/api/doc/extract", { text: "烏龍茶 350 元", fields: "品名, 價格" });
    assert.match(last(ev, "error").message, /JSON/);
  });
  test("Claude 拒絕回答（refusal）", async () => {
    await api("/api/settings", { provider: "anthropic", anthropicKey: "sk-ant-test", claudeModel: "claude-opus-5-5" });
    const ev = await stream("/api/doc/summarize", { text: "REFUSE_ME 這段內容" });
    assert.match(last(ev, "error").message, /拒絕/);
  });
  test("Claude 請求格式：Opus 開啟伺服器端備援、Haiku 不開；effort 正確傳遞", async () => {
    world.claude.calls.length = 0;
    await api("/api/settings", { provider: "anthropic", anthropicKey: "sk-ant-test", claudeModel: "claude-opus-5-5", effort: "high", usageMode: "quality" });
    await api("/api/settings/test", {});
    let c = world.claude.calls.at(-1);
    assert.equal(c.body.model, "claude-opus-5-5");
    assert.equal(c.body.fallbacks, "default");
    assert.match(c.headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
    assert.deepEqual(c.body.output_config, { effort: "high" });
    assert.equal(c.body.stream, true);
    assert.equal(c.body.temperature, undefined);
    await api("/api/settings", { claudeModel: "claude-haiku-5-5", effort: "" });
    await api("/api/settings/test", {});
    c = world.claude.calls.at(-1);
    assert.equal(c.body.fallbacks, undefined);
    assert.equal(c.body.output_config, undefined);
  });
});

// ================= 工作流引擎的每一種節點 =================
describe("每一種節點至少執行一次", () => {
  before(() => useProvider("OpenAI 相容（一般）"));
  test("全部節點串成一條工作流", async () => {
    const kb = await api("/api/kb", { name: "節點測試" });
    const f = await upload("說明.txt");
    const flow = await api("/api/flows", {
      name: "全節點",
      nodes: [
        { id: "a", type: "fetch_url", url: "{{input}}/about", mode: "article", out: "page" },
        { id: "b", type: "crawl", url: "{{input}}/docs/", maxPages: 3, maxDepth: 1, include: "/docs/", out: "site" },
        { id: "c", type: "http", method: "POST", url: "{{input}}/api/echo", headers: "Authorization: Bearer abc", body: '{"t":"{{page.title}}"}', out: "api" },
        { id: "d", type: "read_file", fileId: f.id, out: "doc" },
        { id: "e", type: "kb_add", kbId: kb.id, source: "{{doc}}", title: "說明", out: "kbResult" },
        { id: "f", type: "kb_search", kbId: kb.id, query: "退款", k: 3, out: "context" },
        { id: "g", type: "llm", prompt: "根據：{{context}}", out: "ai" },
        { id: "h", type: "llm_each", list: "{{input}}/news/1\n{{input}}/news/2", fetch: true, prompt: "摘要：{{item}}", out: "items" },
        { id: "i", type: "translate", source: "{{page}}", target: "en", out: "translated" },
        { id: "j", type: "summarize", source: "{{site}}", style: "重點", out: "summary" },
        { id: "k", type: "extract", source: "{{input}}/products 烏龍茶 350 紅茶 280", fields: "品名, 價格", out: "table" },
        { id: "l", type: "site_check", url: "{{input}}", out: "check" },
        { id: "m", type: "condition", left: "{{check.score}}", op: "lt", right: "101" },
        { id: "n", type: "set", value: "# {{today}}\n{{ai}}\n{{api.received}}\n{{check.grade}}", out: "text" },
        { id: "o1", type: "save_file", source: "{{text}}", format: "md", filename: "全節點", out: "f1" },
        { id: "o2", type: "save_file", source: "{{table}}", format: "csv", filename: "表格", out: "f2" },
        { id: "o3", type: "save_file", source: "{{api}}", format: "json", filename: "api", out: "f3" },
        { id: "o4", type: "save_file", source: "{{items}}", format: "txt", filename: "逐項", out: "f4" },
        { id: "p", type: "webhook", url: "", message: "完成：{{f1}}" },
      ],
    });
    const ev = await stream("/api/flows/run", { id: flow.id, input: world.site.url });
    const done = last(ev, "done");
    assert.equal(done?.status, "success", last(ev, "error")?.message);
    assert.equal(done.files.length, 4);
    const md = (await download(done.files[0])).toString("utf8");
    assert.match(md, /\{"t":"關於我們"\}/, "POST 內容應帶入變數");
    assertClean(md, "全節點輸出");
    const csv = (await download(done.files[1])).toString("utf8");
    assert.match(csv, /^﻿品名,價格\r\n烏龍茶,350/);
    const api3 = JSON.parse((await download(done.files[2])).toString("utf8"));
    assert.equal(api3.auth, "Bearer abc");
    for (const e of ev.filter((x) => x.type === "node-done")) assertClean(e.preview, "節點 " + e.node);
  });
  test("工作流可以中途取消", async () => {
    const flow = await api("/api/flows", { name: "取消", nodes: [{ id: "a", type: "crawl", url: world.site.url + "/", maxPages: 50, maxDepth: 5 }] });
    const ac = new AbortController();
    const p = fetch(BASE + "/api/flows/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: flow.id }), signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    await assert.rejects(p.then((r) => r.text()));
    await new Promise((r) => setTimeout(r, 1500));
    const runs = await api("/api/runs");
    const run = runs.find((x) => x.flowId === flow.id);
    assert.ok(run && run.status !== "running", "取消後執行紀錄應結束");
  });
});

// ================= 安全性 =================
describe("安全性", () => {
  test("拒絕其他網站的跨站請求（CSRF）", async () => {
    const res = await fetch(BASE + "/api/settings", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" });
    assert.equal(res.status, 403);
  });
  test("下載檔案不能跳出 outputs 資料夾", async () => {
    for (const p of ["/api/outputs/..%2Fsettings.json", "/api/outputs/..%5Csettings.json", "/api/outputs/%2e%2e%2fsettings.json"]) {
      const res = await fetch(BASE + p);
      assert.equal(res.status, 404, p);
    }
  });
  test("設定 API 不會回傳完整金鑰", async () => {
    await api("/api/settings", { anthropicKey: "sk-ant-abcdefghijklmnop" });
    const s = await api("/api/settings");
    assert.ok(!JSON.stringify(s).includes("abcdefghijklmnop"));
  });
});

// ================= API 用量控管 =================
describe("API 用量控管", () => {
  test("回應快取：同樣的工作第二次執行不再呼叫 API", async () => {
    await useProvider("OpenAI 相容（一般）");
    await api("/api/cache/clear", {});
    await api("/api/settings", { cacheDays: 7 });
    const idx = await tplIndex("外文文章");
    const before = world.openai.calls.length;
    const r1 = await runTemplate(idx, { input: world.site.url + "/en" });
    const first = world.openai.calls.length - before;
    assert.ok(first >= 2);
    assert.equal(r1.done.usage.calls, first);
    const r2 = await runTemplate(idx, { input: world.site.url + "/en" });
    assert.equal(world.openai.calls.length - before, first, "第二次應全部使用快取");
    assert.equal(r2.done.usage.calls, 0);
    assert.equal(r2.done.usage.cached, first);
    const u = await api("/api/usage");
    assert.ok(u.today.cached >= first);
    await api("/api/cache/clear", {});
    await api("/api/settings", { cacheDays: 0 });
  });

  test("逐項 AI 處理會合併成批次：3 個網址只需 1 次呼叫（簡報總共 2 次）", async () => {
    await useProvider("OpenAI 相容（一般）");
    const before = world.openai.calls.length;
    const input = [world.site.url + "/news/1", world.site.url + "/news/2", world.site.url + "/about"].join("\n");
    const r = await runTemplate(await tplIndex("每日簡報"), { input });
    assert.equal(r.status, "success", r.error?.message);
    assert.equal(world.openai.calls.length - before, 2);
    const items = r.events.find((e) => e.type === "node-done" && e.var === "items").preview;
    assert.match(items, /第1項摘要/);
    assert.match(items, /第3項摘要/);
  });

  test("批次結果數量不對時，自動退回逐項處理（結果仍正確）", async () => {
    await useProvider("OpenAI 相容（一般）");
    const flow = await api("/api/flows", { name: "逐項", nodes: [{ id: "a", type: "llm_each", list: "甲\n乙\n丙", prompt: "說明 {{item}}", out: "items" }] });
    // badjson 模型不會回 JSON → 應退回逐項
    await api("/api/settings", { openaiModel: "badjson" });
    const ev = await stream("/api/flows/run", { id: flow.id });
    assert.equal(last(ev, "done").status, "success");
    assert.ok(ev.some((e) => e.type === "log" && /改為逐項/.test(e.message)));
    await api("/api/settings", { openaiModel: "mock" });
  });

  test("Claude 省用量模式：機械性工作用 low 思考深度、表格用結構化輸出；品質模式則不降低", async () => {
    await useProvider("Claude Opus 5.5");
    world.claude.calls.length = 0;
    await stream("/api/doc/translate", { text: "Hello world", target: "zh-TW" });
    assert.equal(world.claude.calls.at(-1).body.output_config.effort, "low");
    await stream("/api/doc/extract", { text: "烏龍茶 350 元", fields: "品名, 價格" });
    const ex = world.claude.calls.at(-1).body;
    assert.equal(ex.output_config.format.type, "json_schema");
    assert.equal(ex.output_config.effort, "low");
    assert.equal(world.claude.calls.length, 2, "結構化輸出不需重試");
    await stream("/api/doc/summarize", { text: "內容".repeat(50) });
    assert.equal(world.claude.calls.at(-1).body.output_config, undefined, "摘要需要品質，維持預設思考深度");
    await api("/api/settings", { usageMode: "quality", effort: "high" });
    await stream("/api/doc/translate", { text: "Hello again", target: "zh-TW" });
    assert.equal(world.claude.calls.at(-1).body.output_config.effort, "high");
    await api("/api/settings", { usageMode: "economy", effort: "" });
  });

  test("送給 AI 的網頁內容已去除圖片等不必要的內容", async () => {
    await useProvider("OpenAI 相容（一般）");
    const flow = await api("/api/flows", {
      name: "精簡",
      nodes: [
        { id: "a", type: "fetch_url", url: world.site.url + "/", mode: "full", out: "page" },
        { id: "b", type: "llm", prompt: "{{page}}", out: "ai" },
      ],
    });
    const before = world.openai.calls.length;
    await stream("/api/flows/run", { id: flow.id });
    const sent = world.openai.calls.slice(before).map((c) => c.messages.at(-1).content).join("");
    assert.ok(sent.includes("退貨期限"));
    assert.ok(!/!\[[^\]]*\]\(/.test(sent), "不應包含圖片語法");
    assert.ok(!/\n{3,}/.test(sent), "不應有多餘空行");
  });

  test("用量統計：每次執行回報呼叫次數與 token，並寫入執行紀錄", async () => {
    await useProvider("Claude Opus 5.5");
    const r = await runTemplate(await tplIndex("外文文章"), { input: world.site.url + "/en" });
    assert.ok(r.done.usage.calls >= 2);
    assert.ok(r.done.usage.inputTokens > 0 && r.done.usage.outputTokens > 0);
    const runs = await api("/api/runs");
    assert.equal(runs.find((x) => x.flowId === r.flow.id).usage.calls, r.done.usage.calls);
  });

  test("條件不成立時完全不呼叫 AI（巡檢分數夠高、網頁沒變動）", async () => {
    await useProvider("OpenAI 相容（一般）");
    const meta = await api("/api/meta");
    const tpl = structuredClone(meta.templates[await tplIndex("健康巡檢")]);
    tpl.nodes.find((n) => n.type === "condition").right = "0"; // 分數永遠不會小於 0
    const flow = await api("/api/flows", tpl);
    const before = world.openai.calls.length;
    const ev = await stream("/api/flows/run", { id: flow.id, input: world.site.url });
    assert.equal(last(ev, "done").status, "stopped");
    assert.equal(world.openai.calls.length, before);
  });
});
