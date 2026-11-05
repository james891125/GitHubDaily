// 服務目錄整合測試：每一個服務都透過真正的伺服器 API 執行，並檢查輸出與 AI 用量
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { startStack, last, cleanCheck } from "./helpers.js";
import { SERVICES } from "../lib/services.js";
import { parseDocument } from "../lib/docs.js";

let S;
const tested = new Set();
before(async () => {
  S = await startStack();
});
after(() => S?.close());

const useClaude = () => S.api("/api/settings", { provider: "anthropic", anthropicKey: "sk-ant-test", claudeModel: "claude-opus-5-5", cacheDays: 0, usageMode: "economy", effort: "", webhookUrl: S.world.webhook.url });
const useOpenAI = (model = "mock") => S.api("/api/settings", { provider: "openai", openaiKey: "sk-test", openaiBase: S.world.openai.base, openaiModel: model, cacheDays: 0, usageMode: "economy", webhookUrl: S.world.webhook.url });

/** 執行服務，回傳 { status, events, done, error, files, usage, aiCalls } */
async function run(id, form) {
  tested.add(id);
  const before = S.world.claude.calls.length + S.world.openai.calls.length;
  const events = await S.stream("/api/services/run", { id, form });
  const done = last(events, "done");
  const error = last(events, "error");
  return {
    events,
    done,
    error,
    status: done?.status || "error",
    files: done?.files || [],
    usage: last(events, "usage")?.usage,
    aiCalls: S.world.claude.calls.length + S.world.openai.calls.length - before,
    skipped: events.filter((e) => e.type === "node-skip").map((e) => e.node),
  };
}
const ok = (r) => assert.equal(r.status, "success", r.error?.message || JSON.stringify(r.events.slice(-3)));
const docText = async (file) => (await parseDocument(file.name, await S.download(file))).text;
const text = (t) => ({ kind: "text", text: t });

describe("文書行政", () => {
  before(useClaude);
  test("公文撰寫：輸出標楷體 Word，使用臺灣用語的系統提示", async () => {
    const r = await run("official-document", { kind: "簽", org: "國立○○大學 教務處", content: "擬於 8 月 20 日舉辦新生說明會，經費 3 萬元。" });
    ok(r);
    assert.equal(r.aiCalls, 1);
    const call = S.world.claude.calls.at(-1).body;
    assert.match(call.system, /臺灣/);
    assert.match(call.messages[0].content, /新生說明會/);
    assert.ok(r.files[0].name.endsWith(".docx"));
    const docx = await S.download(r.files[0]);
    assert.ok(docx.toString("latin1").includes("word/document.xml"));
    assert.match(docx.toString("utf8") + (await docText(r.files[0])), /AI 回覆/);
  });
  test("公文撰寫：缺少必填欄位時提示", async () => {
    const r = await run("official-document", { kind: "簽" });
    assert.equal(r.status, "error");
    assert.match(r.error.message, /請填寫「事由與重點」/);
  });
  test("會議紀錄整理：上傳檔案作為來源", async () => {
    const f = await S.upload("會議紀錄.docx");
    const r = await run("meeting-minutes", { title: "系務會議", doc: { kind: "file", fileId: f.id } });
    ok(r);
    assert.match(S.world.claude.calls.at(-1).body.messages[0].content, /下週三前完成報價/);
    cleanCheck(assert, await docText(r.files[0]), "會議紀錄");
  });
  test("信件回覆草稿：省用量模式使用 low", async () => {
    const r = await run("email-reply", { mail: "請問您能出席 11/20 的會議嗎？", points: "可以出席", tone: "正式", lang: "繁體中文" });
    ok(r);
    assert.equal(r.aiCalls, 1);
    assert.match(r.done.output, /AI 回覆/);
  });
  test("錯字與語句校對：使用 low 思考深度", async () => {
    const r = await run("proofread", { doc: text("今天的會義改到明天。"), level: "輕度" });
    ok(r);
    assert.equal(S.world.claude.calls.at(-1).body.output_config?.effort, "low");
  });
  test("文件摘要：以網址為來源", async () => {
    const r = await run("summarize", { doc: { kind: "url", url: S.world.site.url + "/about" }, style: "重點條列" });
    ok(r);
    assert.match(S.world.claude.calls.at(-1).body.messages[0].content, /成立於 2010 年/);
    assert.match(r.files[0].name, /摘要-關於我們\.docx$/);
  });
  test("文件版本比對：不勾選 AI 時完全不呼叫 API；勾選才呼叫", async () => {
    const a = text("第一條 會員應繳費。\n第二條 退費七天內。");
    const b = text("第一條 會員應按時繳費。\n第二條 退費十四天內。\n第三條 新增條款。");
    let r = await run("compare", { a, b, explain: false });
    ok(r);
    assert.equal(r.aiCalls, 0);
    assert.deepEqual(r.skipped, ["explain"]);
    const t = await docText(r.files[0]);
    assert.match(t, /新增 \d+ 字/);
    assert.match(t, /退費十四天內/);
    r = await run("compare", { a, b, explain: true });
    ok(r);
    assert.equal(r.aiCalls, 1);
  });
  test("繁簡轉換：不呼叫 API，轉換臺灣用詞", async () => {
    const r = await run("zh-convert", { doc: text("这个软件的网络设置"), mode: "s2twp" });
    ok(r);
    assert.equal(r.aiCalls, 0);
    assert.match(await docText(r.files[0]), /這個軟體的網路設定/);
  });
});

describe("學術研究", () => {
  before(useClaude);
  test("文獻搜尋與整理：輸出 Excel，不呼叫 API", async () => {
    const r = await run("literature-search", { query: "meshless method", source: "openalex", limit: 20, sort: "cited", synth: false });
    ok(r);
    assert.equal(r.aiCalls, 0);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await S.download(r.files[0]));
    const ws = wb.worksheets[0];
    assert.equal(ws.getCell("A1").value, "標題");
    assert.equal(ws.getCell("A2").value, "meshless method study 1");
    assert.equal(ws.getCell("E2").value, "100");
    assert.equal(ws.rowCount, 4);
  });
  test("文獻搜尋：arXiv 來源、勾選 AI 綜整", async () => {
    const r = await run("literature-search", { query: "graph neural network", source: "arxiv", synth: true });
    ok(r);
    assert.equal(r.aiCalls, 1);
    assert.match(S.world.claude.calls.at(-1).body.messages[0].content, /New results on graph neural network/);
  });
  test("文獻搜尋：查無結果時仍正常完成", async () => {
    const r = await run("literature-search", { query: "nothing-found", source: "openalex" });
    ok(r);
  });
  test("文獻回顧草稿：只引用搜尋到的論文", async () => {
    const r = await run("literature-review", { query: "meshless method", fromYear: 2015, lang: "繁體中文" });
    ok(r);
    const call = S.world.claude.calls.at(-1).body;
    assert.match(call.system, /不得捏造/);
    assert.match(call.messages[0].content, /meshless method study 3/);
  });
  test("論文翻譯與摘要：只摘要（不翻全文）時省下翻譯呼叫", async () => {
    const f = await S.upload("中文報告.pdf");
    const r1 = await run("paper-translate", { doc: { kind: "file", fileId: f.id }, target: "en", full: false });
    ok(r1);
    assert.deepEqual(r1.skipped, ["tr"]);
    const r2 = await run("paper-translate", { doc: { kind: "file", fileId: f.id }, target: "en", full: true });
    ok(r2);
    assert.ok(r2.aiCalls > r1.aiCalls);
    const t = await docText(r2.files[0]);
    assert.match(t, /中文報告\.pdf/);
    cleanCheck(assert, t, "論文翻譯");
  });
  test("參考文獻格式：APA 與 BibTeX，查無 DOI 時標示，不呼叫 API", async () => {
    let r = await run("citation", { dois: "10.1016/j.enganabound.2017.10.009\nhttps://doi.org/10.4040/missing", style: "apa" });
    ok(r);
    assert.equal(r.aiCalls, 0);
    let t = (await S.download(r.files[0])).toString("utf8");
    assert.match(t, /Ku, C\.-Y\. \(2018\).*\[apa\]/);
    assert.match(t, /10\.4040\/missing：查無此 DOI/);
    r = await run("citation", { dois: "10.1016/j.enganabound.2017.10.009", style: "bibtex" });
    t = (await S.download(r.files[0])).toString("utf8");
    assert.match(t, /^@article\{Ku_2018/);
  });
  test("參考文獻格式：沒有 DOI 時說明格式", async () => {
    const r = await run("citation", { dois: "隨便打的文字", style: "apa" });
    assert.match(r.error.message, /找不到 DOI/);
  });
  test("研究主題追蹤：arXiv 最新論文 + 通知", async () => {
    const before = S.world.webhook.received.length;
    const r = await run("research-tracker", { query: "physics-informed neural network", source: "arxiv", notify: true });
    ok(r);
    assert.equal(S.world.webhook.received.length, before + 1);
    assert.match(S.world.webhook.received.at(-1).text, /研究主題追蹤：physics-informed/);
  });
});

describe("文件與資料", () => {
  test("掃描文件文字辨識：掃描型 PDF 交給 Claude 直接閱讀", async () => {
    await useClaude();
    const f = await S.upload("掃描檔.pdf");
    assert.equal(f.needsOcr, true);
    const r = await run("ocr", { file: f.id });
    ok(r);
    const blocks = S.world.claude.calls.at(-1).body.messages[0].content;
    assert.equal(blocks[0].type, "document");
    assert.equal(blocks[0].source.media_type, "application/pdf");
    assert.match(await docText(r.files[0]), /圖書館開放時間/);
  });
  test("掃描檔不能直接用於一般文件服務，會提示改用文字辨識", async () => {
    const f = await S.upload("掃描檔.pdf");
    const r = await run("summarize", { doc: { kind: "file", fileId: f.id } });
    assert.match(r.error.message, /掃描文件文字辨識/);
  });
  test("文字辨識：圖片可用 OpenAI 相容模型；PDF 則提示需要 Claude", async () => {
    await useOpenAI();
    const img = await S.upload("截圖.png");
    let r = await run("ocr", { file: img.id });
    ok(r);
    assert.equal(S.world.openai.calls.at(-1).messages.at(-1).content[1].type, "image_url");
    const pdf = await S.upload("掃描檔.pdf");
    r = await run("ocr", { file: pdf.id });
    assert.match(r.error.message, /需要使用 Claude/);
    await useClaude();
  });
  test("文件翻譯：術語表會送給 AI", async () => {
    const r = await run("translate", { doc: text("Large Language Model is useful."), target: "zh-TW", glossary: "Large Language Model = 大型語言模型" });
    ok(r);
    assert.match(S.world.claude.calls.at(-1).body.messages[0].content, /大型語言模型/);
  });
  test("資料擷取成 Excel", async () => {
    const f = await S.upload("報價單.docx");
    const r = await run("extract-table", { doc: { kind: "file", fileId: f.id }, fields: "項目, 數量, 單價, 金額, 備註" });
    ok(r);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await S.download(r.files[0]));
    assert.equal(wb.worksheets[0].getCell("A2").value, "伺服器");
  });
  test("資料表分析報告：統計在本機計算，只把統計結果送給 AI", async () => {
    const f = await S.upload("成績.csv");
    const r = await run("data-analysis", { file: f.id, question: "各系所期末成績差異" });
    ok(r);
    assert.equal(r.aiCalls, 1);
    const sent = S.world.claude.calls.at(-1).body.messages[0].content;
    assert.match(sent, /\| 期末 \| 5 \| 0 \| 396 \| 79\.2 \|/);
    const t = await docText(r.files[0]);
    assert.match(t, /資料統計摘要/);
  });
  test("資料表分析：不是表格檔時清楚提示", async () => {
    const f = await S.upload("說明.txt");
    const r = await run("data-analysis", { file: f.id });
    assert.equal(r.status, "error");
    assert.match(r.error.message, /標題列|CSV|Excel/);
  });
  test("文件轉純文字：不呼叫 API", async () => {
    const f = await S.upload("庫存.xlsx");
    const r = await run("to-markdown", { doc: { kind: "file", fileId: f.id } });
    ok(r);
    assert.equal(r.aiCalls, 0);
    assert.match((await S.download(r.files[0])).toString("utf8"), /\| 鍵盤 \| 12 \|/);
  });
});

describe("網站與資訊", () => {
  before(useClaude);
  test("網站健康檢查：預設不呼叫 API；勾選通知且分數低於 80 時發送", async () => {
    let r = await run("site-check", { url: S.world.site.url, advise: false, notify: false });
    ok(r);
    assert.equal(r.aiCalls, 0);
    assert.match(await docText(r.files[0]), /網站檢測報告/);
    const before = S.world.webhook.received.length;
    r = await run("site-check", { url: S.world.site.url, advise: true, notify: true });
    ok(r);
    assert.equal(r.aiCalls, 1);
    assert.equal(S.world.webhook.received.length, before + 1);
  });
  test("網頁變動監控：第一次建立基準，第二次偵測變動並通知", async () => {
    const form = { url: S.world.site.url + "/changing", notify: true };
    const r1 = await run("page-monitor", form);
    assert.equal(r1.status, "stopped");
    assert.equal(r1.aiCalls, 0);
    const before = S.world.webhook.received.length;
    const r2 = await run("page-monitor", form);
    ok(r2);
    assert.equal(S.world.webhook.received.length, before + 1);
  });
  test("新聞與公告摘要：RSS 與 Atom、過濾舊聞、多來源只呼叫一次 AI", async () => {
    const r = await run("news-digest", { feeds: `${S.world.site.url}/rss.xml\n${S.world.site.url}/atom.xml\n${S.world.site.url}/about`, days: 2, topic: "數位學習" });
    ok(r);
    assert.equal(r.aiCalls, 1);
    const sent = S.world.claude.calls.at(-1).body.messages[0].content;
    assert.match(sent, /數位學習補助計畫/);
    assert.match(sent, /Atom 期刊新文章/);
    assert.ok(!sent.includes("舊聞"), "應過濾 2 天前的舊聞");
    assert.ok(r.events.some((e) => e.type === "log" && /不是 RSS/.test(e.message)), "非 RSS 網址應記錄錯誤但不中斷");
  });
  test("外文網頁翻譯摘要", async () => {
    const r = await run("web-translate", { url: S.world.site.url + "/en", full: true });
    ok(r);
    assert.match(await docText(r.files[0]), /A Guide to Oolong Tea/);
  });
  test("網路研究報告：Claude 網路搜尋，附參考來源", async () => {
    const r = await run("web-research", { question: "大專校院數位學習補助", searches: 3 });
    ok(r);
    const call = S.world.claude.calls.at(-1).body;
    assert.deepEqual(call.tools, [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }]);
    const t = await docText(r.files[0]);
    assert.match(t, /參考來源/);
    assert.match(t, /www\.edu\.tw\/news\/1/);
  });
  test("網路研究報告：伺服器端暫停（pause_turn）時自動繼續", async () => {
    const n = S.world.claude.calls.length;
    const r = await run("web-research", { question: "PAUSE_ME 測試" });
    ok(r);
    assert.equal(S.world.claude.calls.length - n, 2);
    assert.equal(S.world.claude.calls.at(-1).body.messages.at(-1).role, "assistant");
  });
  test("網路研究報告：使用 OpenAI 相容服務時提示需要 Claude", async () => {
    await useOpenAI();
    const r = await run("web-research", { question: "測試" });
    assert.match(r.error.message, /需要使用 Claude/);
    await useClaude();
  });
  test("網站匯入知識庫", async () => {
    const kb = await S.api("/api/kb", { name: "說明文件" });
    const r = await run("site-to-kb", { url: S.world.site.url + "/docs/", kb: kb.id, include: "/docs/", max: 10 });
    ok(r);
    assert.equal(r.aiCalls, 0);
    assert.equal((await S.api("/api/kb/detail?id=" + kb.id)).docs.length, 3);
  });
});

describe("定期執行與共通行為", () => {
  before(useClaude);
  test("服務可設為定期執行，存成排程工作流並可手動執行", async () => {
    const f = await S.api("/api/services/schedule", { id: "page-monitor", form: { url: S.world.site.url + "/changing", notify: false }, schedule: { mode: "daily", time: "08:00" } });
    assert.equal(f.schedule.enabled, true);
    assert.equal(f.serviceId, "page-monitor");
    const ev = await S.stream("/api/flows/run", { id: f.id });
    assert.ok(["stopped", "success"].includes(last(ev, "done")?.status), last(ev, "error")?.message);
  });
  test("不支援定期執行的服務會拒絕", async () => {
    await assert.rejects(S.api("/api/services/schedule", { id: "official-document", form: { content: "x" } }), /不支援/);
  });
  test("網址欄位格式錯誤時提示", async () => {
    const r = await run("site-check", { url: "不是網址" });
    assert.match(r.error.message, /不是有效的網址/);
  });
  test("每一個服務的輸出都不含程式錯誤痕跡（以 OpenAI 相容模式重跑代表性服務）", async () => {
    await useOpenAI();
    for (const [id, form] of [
      ["official-document", { kind: "函", content: "函請各學院推薦委員" }],
      ["summarize", { doc: text("內容".repeat(30)), style: "重點條列" }],
      ["news-digest", { feeds: S.world.site.url + "/rss.xml", days: 7 }],
    ]) {
      const r = await run(id, form);
      ok(r);
      cleanCheck(assert, r.done.output, id);
    }
  });
  test("所有服務都有測試涵蓋", () => {
    const missing = SERVICES.map((s) => s.id).filter((id) => !tested.has(id));
    assert.deepEqual(missing, [], "以下服務沒有測試：" + missing.join(", "));
  });
});
