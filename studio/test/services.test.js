// 服務目錄整合測試：每一個服務都透過真正的伺服器 API 執行，並檢查輸出與 AI 用量
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { startStack, last, cleanCheck, makePdf } from "./helpers.js";
import { SERVICES } from "../lib/services.js";
import { parseDocument } from "../lib/docs.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { findFfmpeg } from "../lib/audio.js";

let S;
const tested = new Set();
before(async () => {
  // 音檔上限調小到 0.25 MB，以短音檔測試自動分段
  S = await startStack({ env: { STUDIO_AUDIO_LIMIT_MB: "0.25" } });
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
/** 以內建 ffmpeg 產生測試用的純音音檔 */
function tone(sec, ext = "wav") {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tone-")), "t." + ext);
  const r = spawnSync(findFfmpeg(), ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=440:duration=${sec}`, "-ar", "16000", "-ac", "1", out]);
  assert.equal(r.status, 0, String(r.stderr));
  return fs.readFileSync(out);
}

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
    assert.match(r.error.message, /無法直接讀取 PDF。掃描型 PDF 請改用 Claude、OpenAI 或 OpenRouter/);
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

describe("影音與圖片", () => {
  const speechVia = (provider, model = "") => S.api("/api/settings", { speechProvider: provider, speechModel: model, groqKey: "gsk-test", openaiKey: "sk-test", geminiKey: "gm-test", openrouterKey: "or-test" });
  before(async () => {
    await useClaude();
    await speechVia("groq", "whisper-large-v3-turbo");
  });
  test("錄音轉逐字稿：Groq Whisper，簡體結果自動轉為臺灣用語，產生 Word 與字幕檔", async () => {
    const f = await S.upload("錄音.mp3");
    assert.equal(f.needsTranscribe, true);
    const r = await run("transcribe", { file: f.id, language: "zh-TW", prompt: "系務會議", subtitles: true });
    ok(r);
    const req = S.world.openai.media.filter((m) => m.path?.endsWith("/audio/transcriptions")).at(-1);
    assert.equal(req.model, "whisper-large-v3-turbo");
    assert.equal(req.format, "verbose_json");
    assert.equal(req.language, "zh");
    assert.match(req.prompt, /繁體中文.*系務會議/);
    const t = await docText(r.files.find((x) => x.name.endsWith(".docx")));
    assert.match(t, /軟體採購和網路設定/);
    assert.match(t, /下週三/);
    assert.ok(!/软件|网络/.test(t), "應已轉為繁體");
    const srt = (await S.download(r.files.find((x) => x.name.endsWith(".srt")))).toString("utf8");
    assert.match(srt, /^1\n00:00:00,000 --> 00:00:03,200\n大家好/);
    assert.match(srt, /\n2\n00:00:03,200 --> 00:00:06,500\n決議/);
  });
  test("錄音轉逐字稿：OpenAI gpt-4o-transcribe（無時間軸）要求字幕時清楚說明", async () => {
    await speechVia("openai", "gpt-4o-transcribe");
    const f = await S.upload("錄音.wav");
    let r = await run("transcribe", { file: f.id, subtitles: false });
    ok(r);
    assert.equal(S.world.openai.media.filter((m) => m.path?.endsWith("/audio/transcriptions")).at(-1).format, "json");
    r = await run("transcribe", { file: f.id, subtitles: true });
    assert.match(r.error.message, /字幕檔需要含時間軸/);
    await speechVia("groq", "whisper-large-v3-turbo");
  });
  test("錄音轉逐字稿：Gemini 以 input_audio 直接聽 MP3；M4A 等格式提示轉檔", async () => {
    await speechVia("gemini", "gemini-test-flash");
    const mp3 = await S.upload("錄音.mp3");
    let r = await run("transcribe", { file: mp3.id });
    ok(r);
    assert.ok(S.world.openai.media.at(-1).audio);
    assert.match(await docText(r.files[0]), /這是音訊轉寫的結果/);
    // M4A 等格式由內建 ffmpeg 自動轉成 MP3 再送出
    const m4a = await S.uploadBuf("錄音.m4a", tone(5, "m4a"));
    const before = S.world.openai.media.length;
    r = await run("transcribe", { file: m4a.id });
    ok(r);
    assert.equal(S.world.openai.media.length - before, 1);
    assert.match(r.events.filter((e) => e.type === "log").map((e) => e.message).join("\n"), /轉換為語音專用格式/);
    // 損毀的音檔：清楚說明
    const bad = await S.api("/api/files", { name: "壞掉.m4a", data: Buffer.from("fake m4a").toString("base64") });
    r = await run("transcribe", { file: bad.id });
    assert.match(r.error.message, /音檔處理失敗（檔案可能已損毀或不是音訊）/);
    await speechVia("groq", "whisper-large-v3-turbo");
  });
  test("錄音轉逐字稿：長錄音自動分段轉錄，字幕時間軸接續", async () => {
    const long = await S.uploadBuf("長錄音.wav", tone(150));
    const before = S.world.openai.media.filter((m) => m.path?.endsWith("/audio/transcriptions")).length;
    const r = await run("transcribe", { file: long.id, subtitles: true });
    ok(r);
    const reqs = S.world.openai.media.filter((m) => m.path?.endsWith("/audio/transcriptions")).slice(before);
    assert.equal(reqs.length, 3, "150 秒、每段 60 秒 → 3 段");
    assert.ok(reqs.every((q) => q.size < 0.3 * 1024 * 1024));
    // 第二段起，提示包含前一段結尾，讓用詞前後一致
    assert.match(reqs[1].prompt, /報價/);
    assert.match(r.events.filter((e) => e.type === "log").map((e) => e.message).join("\n"), /分 3 段處理/);
    const srt = (await S.download(r.files.find((x) => x.name.endsWith(".srt")))).toString("utf8");
    assert.match(srt, /00:01:00,0\d\d --> 00:01:03,2\d\d/); // MP3 切段點約有數十毫秒誤差
    assert.match(srt, /00:02:00,0\d\d --> 00:02:03,2\d\d/);
    assert.equal((srt.match(/大家好/g) || []).length, 3);
    assert.equal(r.usage.speech, 3);
  });
  test("錄音轉逐字稿：損毀的大檔案清楚說明", async () => {
    const big = await S.api("/api/files", { name: "長錄音.mp3", data: Buffer.alloc(2 * 1024 * 1024, 1).toString("base64") });
    const r = await run("transcribe", { file: big.id });
    assert.match(r.error.message, /音檔處理失敗/);
  });
  test("錄音轉逐字稿：未設定語音服務時說明 Claude 無法處理音檔", async () => {
    await speechVia("");
    const f = await S.upload("錄音.mp3");
    const r = await run("transcribe", { file: f.id });
    assert.match(r.error.message, /語音轉文字.*Claude 無法直接處理音檔/);
    await speechVia("groq", "whisper-large-v3-turbo");
  });
  test("會議錄音整理：轉錄 → 會議紀錄（含逐字稿附錄）", async () => {
    const f = await S.upload("錄音.mp3");
    const r = await run("meeting-audio", { file: f.id, title: "系務會議" });
    ok(r);
    assert.match(S.world.claude.calls.at(-1).body.messages[0].content, /軟體採購/);
    const t = await docText(r.files[0]);
    assert.match(t, /附錄：逐字稿/);
  });
  test("課堂與演講筆記", async () => {
    const f = await S.upload("錄音.wav");
    const r = await run("lecture-notes", { file: f.id, topic: "數值方法" });
    ok(r);
    assert.match(S.world.claude.calls.at(-1).body.messages[0].content, /數值方法/);
  });
  test("音檔不能直接當文件使用，會提示改用轉錄服務", async () => {
    const f = await S.upload("錄音.mp3");
    const r = await run("summarize", { doc: { kind: "file", fileId: f.id } });
    assert.match(r.error.message, /錄音轉逐字稿/);
  });
  test("圖片分析：Claude 收到圖片；不支援圖片的供應商清楚說明", async () => {
    const img = await S.upload("截圖.png");
    let r = await run("image-analysis", { file: img.id, task: "這是一張圖表，請解讀其中的數據、趨勢與結論，並指出值得注意的地方。" });
    ok(r);
    const blocks = S.world.claude.calls.at(-1).body.messages[0].content;
    assert.equal(blocks[0].type, "image");
    assert.match(blocks[1].text, /解讀其中的數據/);
    await S.api("/api/settings", { provider: "deepseek", deepseekKey: "ds-test", deepseekModel: "deepseek-chat" });
    r = await run("image-analysis", { file: img.id });
    assert.match(r.error.message, /DeepSeek 的模型不支援圖片/);
    await useClaude();
  });
  test("AI 圖片生成：OpenAI（gpt-image）、Gemini（Imagen）、OpenRouter（chat 模式）都能產生 PNG", async () => {
    for (const [provider, model, check] of [
      ["openai", "gpt-image-1", (m) => m.path.endsWith("/images/generations") && m.response_format === undefined],
      ["gemini", "imagen-3.0-generate-002", (m) => m.path.endsWith("/images/generations") && m.response_format === "b64_json"],
      ["openrouter", "vendor/image-gen", (m) => m.path.endsWith("/chat/completions") && m.modalities?.includes("image")],
    ]) {
      await S.api("/api/settings", { imageProvider: provider, imageModel: model, openaiKey: "sk-test", geminiKey: "gm-test", openrouterKey: "or-test" });
      const r = await run("image-generate", { desc: "校園秋天的林蔭大道", style: "水彩手繪風格", size: "1536x1024", n: 2 });
      ok(r);
      assert.equal(r.files.length, 2, provider);
      const png = await S.download(r.files[0]);
      assert.equal(png.subarray(1, 4).toString(), "PNG", provider);
      const req = S.world.openai.media.at(-1);
      assert.ok(check(req), `${provider} 請求格式不正確：${JSON.stringify(req).slice(0, 200)}`);
      if (provider !== "openrouter") assert.equal(req.size, "1536x1024");
    }
  });
  test("AI 圖片生成：被安全規則擋下（沒有回傳圖片）時說明原因；未設定時提示", async () => {
    let r = await run("image-generate", { desc: "blocked content" });
    assert.match(r.error.message, /沒有回傳圖片/);
    await S.api("/api/settings", { imageProvider: "" });
    r = await run("image-generate", { desc: "風景" });
    assert.match(r.error.message, /尚未設定「圖片生成」.*Claude 無法產生圖片/);
  });
  test("簡報轉講稿：上傳 PowerPoint，講稿依據投影片內容與講者備註", async () => {
    const f = await S.upload("簡報.pptx");
    const r = await run("slides-script", { doc: { kind: "file", fileId: f.id }, minutes: 8, audience: "系上老師" });
    ok(r);
    const sent = S.world.claude.calls.at(-1).body.messages[0].content;
    assert.match(sent, /第 2 張投影片/);
    assert.match(sent, /\| 感測器 \| 12000 \|/);
    assert.match(sent, /強調節能成效/);
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

describe("問卷分析與報告格式檢查", () => {
  before(useClaude);
  test("問卷結果分析：不勾 AI 時不呼叫 API；產生含圖表的 Word、Excel、HTML，不含個資", async () => {
    const f = await S.upload("問卷回覆.csv");
    const r = await run("survey-analysis", { file: f.id, title: "活動滿意度調查", group: "系所", ai: false });
    ok(r);
    assert.equal(r.aiCalls, 0);
    assert.deepEqual(r.files.map((x) => x.name.replace(/^\d+_/, "")), ["活動滿意度調查.docx", "活動滿意度調查-統計表.xlsx", "活動滿意度調查.html"]);
    const docx = await S.download(r.files[0]);
    const zip = await JSZip.loadAsync(docx);
    assert.equal(Object.keys(zip.files).filter((x) => x.startsWith("word/media/")).length, 6);
    const t = await docText(r.files[0]);
    assert.match(t, /有效問卷：60 份/);
    assert.match(t, /分組比較：依「系所」/);
    assert.ok(!/@example|王同學/.test(t), "報告不應含個資");
    const html = (await S.download(r.files[2])).toString("utf8");
    assert.equal((html.match(/<svg/g) || []).length, 6);
    assert.match(html, /<figcaption[^>]*>圖1 系所<\/figcaption>/);
    assert.ok(!/@@FIG|chart:/.test(html));
    assert.ok(!/chart:\d/.test(r.done.output));
    cleanCheck(assert, r.done.output, "survey");
  });
  test("問卷結果分析：勾選 AI 只送統計與開放題、只呼叫一次", async () => {
    const f = await S.upload("問卷回覆.csv");
    const r = await run("survey-analysis", { file: f.id, ai: true });
    ok(r);
    assert.equal(r.aiCalls, 1);
    const sent = JSON.stringify(S.world.claude.calls.at(-1).body.messages);
    assert.match(sent, /整體滿意度/);
    assert.match(sent, /希望增加晚上的場次/);
    assert.ok(!/@example|王同學/.test(sent), "不可送出個資");
    assert.match(await docText(r.files[0]), /分析摘要/);
  });
  test("問卷結果分析：分組欄位不存在、檔案不是表格時提示", async () => {
    const f = await S.upload("問卷回覆.csv");
    let r = await run("survey-analysis", { file: f.id, group: "不存在的欄位" });
    assert.match(r.error.message, /找不到分組欄位「不存在的欄位」/);
    const d = await S.upload("會議紀錄.docx");
    r = await run("survey-analysis", { file: d.id });
    assert.match(r.error.message, /CSV 或 Excel/);
  });
  test("報告格式檢查：錯誤報告列出問題、自動修正另存新檔，不呼叫 API", async () => {
    const f = await S.upload("報告-格式錯誤.docx");
    const r = await run("report-format-check", { file: f.id, profile: "academic", fix: true, ai: false });
    ok(r);
    assert.equal(r.aiCalls, 0);
    const names = r.files.map((x) => x.name.replace(/^\d+_/, ""));
    assert.ok(names.includes("報告-格式錯誤-格式修正.docx"), names.join());
    const t = await docText(r.files.find((x) => x.name.includes("格式檢查結果")));
    assert.match(t, /未通過/);
    assert.match(t, /自動修正結果/);
    assert.match(t, /由 \d+ 項減為 \d+ 項/);
    assert.match(r.events.filter((e) => e.type === "log").map((e) => e.message).join("\n"), /判斷為學術型報告/);
  });
  test("報告格式檢查：符合規範的報告全部通過；勾選 AI 審閱只呼叫一次（低思考深度）", async () => {
    const f = await S.upload("報告-符合規範.docx");
    const r = await run("report-format-check", { file: f.id, profile: "auto", fix: false, ai: true });
    ok(r);
    assert.equal(r.aiCalls, 1);
    assert.equal(r.files.length, 1);
    assert.match(r.done.output, /未通過 0 項/);
    const body = S.world.claude.calls.at(-1).body;
    assert.equal(body.output_config?.effort, "low");
    assert.match(JSON.stringify(body.messages), /無網格法/);
  });
  test("報告格式檢查：PDF 提示需要 Word 原檔；.doc 自動轉換（需 LibreOffice）", async () => {
    const p = await S.upload("中文報告.pdf");
    let r = await run("report-format-check", { file: p.id });
    assert.match(r.error.message, /需要 Word 檔/);
    const d = await S.upload("會議紀錄.doc");
    r = await run("report-format-check", { file: d.id, fix: false });
    if (r.status === "success") assert.match(r.done.output, /格式檢查/);
    else assert.match(r.error.message, /另存新檔|LibreOffice/);
  });
});

describe("PDF 與圖片工具", () => {
  before(useClaude);
  const pdfPages = async (file) => (await PDFDocument.load(await S.download(file))).getPageCount();
  test("PDF 合併：依清單順序，不呼叫 API；少於 2 個檔提示", async () => {
    const a = await S.uploadBuf("甲.pdf", await makePdf(2, "A"));
    const b = await S.uploadBuf("乙.pdf", await makePdf(3, "B", 600));
    const r = await run("pdf-merge", { files: [b.id, a.id], filename: "合併結果" });
    ok(r);
    assert.equal(r.aiCalls, 0);
    assert.equal(r.files[0].name.replace(/^\d+_/, ""), "合併結果.pdf");
    assert.equal(await pdfPages(r.files[0]), 5);
    const widths = (await PDFDocument.load(await S.download(r.files[0]))).getPages().map((p) => Math.round(p.getWidth()));
    assert.deepEqual(widths, [600, 600, 600, 595, 595], "應依選擇順序合併");
    const one = await run("pdf-merge", { files: [a.id] });
    assert.match(one.error.message, /至少需要 2 個檔案/);
    const none = await run("pdf-merge", { files: [] });
    assert.match(none.error.message, /請選擇「PDF 檔案/);
  });
  test("PDF 分割：多個檔打包成 ZIP；自訂範圍", async () => {
    const f = await S.uploadBuf("講義.pdf", await makePdf(5));
    let r = await run("pdf-split", { files: [f.id], mode: "every", every: 2 });
    ok(r);
    const zip = await JSZip.loadAsync(await S.download(r.files[0]));
    assert.deepEqual(Object.keys(zip.files).sort(), ["分割-" + new Date().toLocaleDateString("sv-SE") + "-第1-2頁.pdf", "分割-" + new Date().toLocaleDateString("sv-SE") + "-第3-4頁.pdf", "分割-" + new Date().toLocaleDateString("sv-SE") + "-第5頁.pdf"].sort());
    r = await run("pdf-split", { files: [f.id], mode: "ranges", ranges: "1-3; 4-" });
    ok(r);
    assert.match(r.done.output, /分割成 2 個檔案/);
  });
  test("PDF 頁面整理：擷取、刪除、旋轉；頁碼超出範圍時提示", async () => {
    const f = await S.uploadBuf("頁面.pdf", await makePdf(4));
    let r = await run("pdf-pages", { files: [f.id], op: "extract", ranges: "4, 1" });
    ok(r);
    assert.equal(await pdfPages(r.files[0]), 2);
    r = await run("pdf-pages", { files: [f.id], op: "delete", ranges: "1-3" });
    ok(r);
    assert.equal(await pdfPages(r.files[0]), 1);
    r = await run("pdf-pages", { files: [f.id], op: "rotate", ranges: "", angle: "180" });
    ok(r);
    const doc = await PDFDocument.load(await S.download(r.files[0]));
    assert.deepEqual(doc.getPages().map((p) => p.getRotation().angle), [180, 180, 180, 180]);
    r = await run("pdf-pages", { files: [f.id], op: "extract", ranges: "9" });
    assert.match(r.error.message, /超出範圍（此檔共 4 頁）/);
    r = await run("pdf-pages", { files: [f.id], op: "delete", ranges: "" });
    assert.match(r.error.message, /請輸入要刪除的頁碼/);
  });
  test("PDF 加浮水印與頁碼：中文、多檔分別處理", async () => {
    const a = await S.uploadBuf("一.pdf", await makePdf(2));
    const b = await S.upload("中文報告.pdf");
    let r = await run("pdf-watermark", { files: [a.id, b.id], text: "僅供審查使用", tile: true, color: "red", opacity: "0.35", size: 40 });
    ok(r);
    const zip = await JSZip.loadAsync(await S.download(r.files[0]));
    assert.deepEqual(Object.keys(zip.files).sort(), ["一-浮水印.pdf", "中文報告-浮水印.pdf"].sort());
    r = await run("pdf-pagenum", { files: [a.id], format: "第 {n} 頁，共 {total} 頁", position: "bottom-right", skipFirst: true });
    ok(r);
    assert.equal(await pdfPages(r.files[0]), 2);
    r = await run("pdf-watermark", { files: [a.id], text: "" });
    assert.match(r.error.message, /請填寫「浮水印文字」/);
  });
  test("PDF 壓縮：含照片的 PDF 變小；非 PDF 檔提示", async () => {
    const photo = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: "#88aacc" } }).jpeg({ quality: 98 }).toBuffer();
    const img = await S.uploadBuf("照片.jpg", photo);
    let r = await run("images-to-pdf", { files: [img.id, img.id], pageSize: "a4", filename: "相簿" });
    ok(r);
    assert.equal(await pdfPages(r.files[0]), 2);
    const big = await S.uploadBuf("相簿.pdf", await S.download(r.files[0]));
    r = await run("pdf-compress", { files: [big.id], level: "high" });
    ok(r);
    assert.ok(r.files[0].size < big.size, `${big.size} → ${r.files[0].size}`);
    assert.match(r.done.output, /減少 \d+%/);
    r = await run("pdf-compress", { files: [img.id] });
    assert.match(r.error.message, /不是 PDF 檔（圖片請使用「圖片轉 PDF」功能）/);
    r = await run("images-to-pdf", { files: [big.id] });
    assert.match(r.error.message, /不是圖片/);
  });
  test("圖片批次處理：縮放轉 WebP、移除 EXIF，多張打包 ZIP；單張直接輸出", async () => {
    const photo = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#4a7" } }).jpeg().withMetadata({ orientation: 1 }).toBuffer();
    const a = await S.uploadBuf("IMG_0001.jpg", photo);
    const b = await S.uploadBuf("截圖2.png", await sharp({ create: { width: 800, height: 600, channels: 4, background: "#fff8" } }).png().toBuffer());
    let r = await run("image-batch", { files: [a.id, b.id], width: 1280, format: "webp", quality: 70 });
    ok(r);
    assert.equal(r.aiCalls, 0);
    const zip = await JSZip.loadAsync(await S.download(r.files[0]));
    assert.deepEqual(Object.keys(zip.files).sort(), ["IMG_0001.webp", "截圖2.webp"]);
    const m = await sharp(await zip.file("IMG_0001.webp").async("nodebuffer")).metadata();
    assert.deepEqual([m.width, m.height, m.exif], [1280, 853, undefined]);
    r = await run("image-batch", { files: [a.id], maxKB: 40, format: "jpg" });
    ok(r);
    assert.ok(r.files[0].name.endsWith("IMG_0001.jpg"));
    assert.ok(r.files[0].size <= 40 * 1024);
    const heic = await S.api("/api/files", { name: "手機.heic", data: Buffer.from("fake").toString("base64") });
    assert.equal(heic.kind, "image");
    r = await run("image-batch", { files: [heic.id] });
    assert.match(r.error.message, /HEIC/);
    const doc = await S.upload("會議紀錄.docx");
    r = await run("image-batch", { files: [doc.id] });
    assert.match(r.error.message, /不是圖片/);
  });
  test("其他圖片格式（TIFF）可直接用於圖片分析，送給 AI 前轉成 PNG", async () => {
    const tif = await S.uploadBuf("掃描.tif", await sharp({ create: { width: 300, height: 200, channels: 3, background: "#fff" } }).tiff().toBuffer());
    const r = await run("image-analysis", { file: tif.id });
    ok(r);
    const img = S.world.claude.calls.at(-1).body.messages[0].content.find((c) => c.type === "image");
    assert.equal(img.source.media_type, "image/png");
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
