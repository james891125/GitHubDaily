// 不使用 AI 的工具模組單元測試：PDF 工具、圖片批次處理、問卷分析、報告格式檢查、長錄音分段
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import JSZip from "jszip";
import { FILES, makePdf } from "./helpers.js";
import * as P from "../lib/pdftools.js";
import { batchImages, processImage } from "../lib/imagetools.js";
import { analyzeSurvey, classify, surveyMarkdown, statsForAI, openAnswersForAI, surveyXlsx, chartFor, svgToPng } from "../lib/survey.js";
import { parseTable } from "../lib/tools.js";
import { checkDocx, fixDocx, resultsToMarkdown } from "../lib/formatcheck.js";
import { markdownToDocx } from "../lib/docx.js";
import { findFfmpeg, prepareAudio, probeDuration } from "../lib/audio.js";

const pageTexts = async (buf) => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) out.push((await (await doc.getPage(i)).getTextContent()).items.map((x) => x.str).join(" ").trim());
  return out;
};
const pdftoppm = spawnSync("which", ["pdftoppm"]).status === 0;
/** 以 pdftoppm 算出第一頁非白色像素比例（確認浮水印、頁碼真的畫上去） */
async function inkRatio(buf, page = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ink-"));
  fs.writeFileSync(path.join(dir, "a.pdf"), buf);
  spawnSync("pdftoppm", ["-r", "30", "-png", "-f", String(page), "-l", String(page), path.join(dir, "a.pdf"), path.join(dir, "p")]);
  const png = fs.readdirSync(dir).find((f) => f.endsWith(".png"));
  const { data, info } = await sharp(path.join(dir, png)).greyscale().raw().toBuffer({ resolveWithObject: true });
  fs.rmSync(dir, { recursive: true, force: true });
  return data.filter((v) => v < 240).length / (info.width * info.height);
}

describe("PDF 工具", () => {
  test("頁碼範圍：區間、單頁、到末頁、反向、中文標點", () => {
    assert.deepEqual(P.parseRanges("1-3, 5, 8-", 9), [0, 1, 2, 4, 7, 8]);
    assert.deepEqual(P.parseRanges("3，1、末頁", 5), [2, 0, 4]);
    assert.deepEqual(P.parseRanges("5-3", 5), [4, 3, 2]);
    assert.deepEqual(P.parseRanges("2～3", 5), [1, 2]);
    assert.deepEqual(P.parseRanges("", 3), [0, 1, 2]);
    assert.throws(() => P.parseRanges("0", 3), /超出範圍/);
    assert.throws(() => P.parseRanges("9", 3), /超出範圍（此檔共 3 頁）/);
    assert.throws(() => P.parseRanges("a-b", 3), /格式不正確/);
  });
  test("合併：依順序、頁數正確；少於 2 個檔案時提示", async () => {
    const r = await P.mergePdfs([{ buf: await makePdf(2, "A"), name: "a.pdf" }, { buf: await makePdf(3, "B"), name: "b.pdf" }]);
    assert.equal(r.pages, 5);
    assert.deepEqual(await pageTexts(r.buf), ["A 1", "A 2", "B 1", "B 2", "B 3"]);
    await assert.rejects(P.mergePdfs([{ buf: await makePdf(1), name: "a.pdf" }]), /至少需要 2 個/);
  });
  test("分割：每頁、每 N 頁、自訂範圍", async () => {
    const src = await makePdf(5);
    assert.deepEqual((await P.splitPdf(src, { mode: "each" })).map((x) => x.label), ["1", "2", "3", "4", "5"]);
    const ev = await P.splitPdf(src, { mode: "every", every: 2 });
    assert.deepEqual(ev.map((x) => [x.label, x.pages]), [["1-2", 2], ["3-4", 2], ["5", 1]]);
    const rg = await P.splitPdf(src, { mode: "ranges", ranges: "1-2; 3-" });
    assert.deepEqual(await pageTexts(rg[1].buf), ["Page 3", "Page 4", "Page 5"]);
    await assert.rejects(P.splitPdf(src, { mode: "ranges", ranges: "" }), /請輸入分割範圍/);
  });
  test("擷取可重新排序；刪除頁面；不能全部刪除", async () => {
    const src = await makePdf(4);
    assert.deepEqual(await pageTexts((await P.extractPages(src, "4, 1-2")).buf), ["Page 4", "Page 1", "Page 2"]);
    const d = await P.deletePages(src, "2-3");
    assert.deepEqual(await pageTexts(d.buf), ["Page 1", "Page 4"]);
    await assert.rejects(P.deletePages(src, "1-4"), /不能刪除全部/);
  });
  test("旋轉：只旋轉指定頁", async () => {
    const r = await P.rotatePdf(await makePdf(3), 90, "2");
    const doc = await PDFDocument.load(r.buf);
    assert.deepEqual(doc.getPages().map((p) => p.getRotation().angle), [0, 90, 0]);
    const r2 = await P.rotatePdf(r.buf, 270, "");
    assert.deepEqual((await PDFDocument.load(r2.buf)).getPages().map((p) => p.getRotation().angle), [270, 0, 270]);
  });
  test("中文浮水印與中文頁碼確實畫在頁面上", { skip: !pdftoppm && "未安裝 pdftoppm" }, async () => {
    const src = await makePdf(2);
    const base = await inkRatio(src);
    const wm = await P.watermarkPdf(src, { text: "機密文件", opacity: 0.5 });
    assert.ok((await inkRatio(wm.buf)) > base + 0.01, "浮水印應增加墨水量");
    const tiled = await P.watermarkPdf(src, { text: "草稿", tile: true, opacity: 0.5 });
    assert.ok((await inkRatio(tiled.buf)) > (await inkRatio(wm.buf)), "鋪滿應比置中更多");
    const pn = await P.addPageNumbers(src, { format: "第 {n} 頁，共 {total} 頁" });
    assert.ok((await inkRatio(pn.buf, 2)) > base);
    await assert.rejects(P.watermarkPdf(src, { text: " " }), /請輸入浮水印文字/);
  });
  test("英數頁碼以文字繪製（可搜尋），封面可不加", async () => {
    const r = await P.addPageNumbers(await makePdf(3), { format: "{n} / {total}", skipFirst: true });
    const t = await pageTexts(r.buf);
    assert.equal(t[0], "Page 1");
    assert.match(t[1], /1 \/ 2/);
    assert.match(t[2], /2 \/ 2/);
  });
  test("壓縮：含大照片的 PDF 明顯變小；純文字 PDF 不會變大", async () => {
    const photo = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: "#88aacc" } })
      .composite([{ input: Buffer.from('<svg width="2400" height="1800"><circle cx="1200" cy="900" r="700" fill="#c33"/></svg>') }])
      .jpeg({ quality: 98 })
      .toBuffer();
    const raw = await sharp(Buffer.from(Array.from({ length: 500 * 400 * 3 }, (_, i) => (i * 7) % 255)), { raw: { width: 500, height: 400, channels: 3 } }).png().toBuffer();
    const src = await P.imagesToPdf([{ buf: photo, name: "p.jpg" }, { buf: raw, name: "r.png" }]);
    const c = await P.compressPdf(src.buf, { level: "high" });
    assert.ok(c.after < c.before * 0.5, `${c.before} → ${c.after}`);
    assert.equal((await PDFDocument.load(c.buf)).getPageCount(), 2);
    const text = await makePdf(3);
    const c2 = await P.compressPdf(text);
    assert.ok(c2.after <= text.length);
  });
  test("圖片轉 PDF：A4 依方向；與圖片同尺寸", async () => {
    const wide = await sharp({ create: { width: 800, height: 400, channels: 3, background: "#fff" } }).png().toBuffer();
    const tall = await sharp({ create: { width: 300, height: 600, channels: 4, background: "#0000" } }).png().toBuffer();
    const r = await P.imagesToPdf([{ buf: wide, name: "w.png" }, { buf: tall, name: "t.png" }]);
    const sizes = (await PDFDocument.load(r.buf)).getPages().map((p) => p.getSize());
    assert.ok(sizes[0].width > sizes[0].height && sizes[1].height > sizes[1].width);
    const fit = await P.imagesToPdf([{ buf: wide, name: "w.png" }], { pageSize: "fit" });
    assert.equal(Math.round((await PDFDocument.load(fit.buf)).getPage(0).getWidth()), 600);
    await assert.rejects(P.imagesToPdf([{ buf: Buffer.from("x"), name: "壞.jpg" }]), /無法讀取為圖片/);
  });
  test("錯誤檔案：不是 PDF、空檔、加密檔", async () => {
    await assert.rejects(P.loadPdf(Buffer.from("hello"), "a.pdf"), /不是 PDF 檔/);
    await assert.rejects(P.loadPdf(Buffer.alloc(0), "a.pdf"), /空的檔案/);
    await assert.rejects(P.loadPdf(Buffer.from("%PDF-1.4\n garbage"), "壞.pdf"), /無法讀取/);
    const real = fs.readFileSync(path.join(FILES, "中文報告.pdf"));
    assert.equal((await P.pdfInfo(real)).pages, 1);
  });
});

describe("圖片批次處理", () => {
  const photo = () => sharp({ create: { width: 4000, height: 3000, channels: 3, background: "#4a7" } }).jpeg({ quality: 95 }).withMetadata({ orientation: 6 }).toBuffer();
  test("縮放、轉 WebP、依 EXIF 轉正、預設移除拍攝資訊", async () => {
    const r = await processImage(await photo(), "IMG_0001.jpg", { width: 1200, format: "webp" });
    assert.equal(r.ext, "webp");
    // 方向 6 代表直拍：轉正後寬 < 高，寬度上限 1200 → 高 1600
    assert.equal(r.width, 1200);
    assert.equal(r.height, 1600);
    const m = await sharp(r.buf).metadata();
    assert.equal(m.orientation, undefined);
    assert.equal(m.exif, undefined);
  });
  test("不會把小圖放大；比例縮放；維持原格式", async () => {
    const small = await sharp({ create: { width: 200, height: 100, channels: 3, background: "#fff" } }).png().toBuffer();
    assert.equal((await processImage(small, "s.png", { width: 1000 })).width, 200);
    const half = await processImage(small, "s.png", { percent: 50 });
    assert.deepEqual([half.width, half.height, half.ext], [100, 50, "png"]);
  });
  test("檔案大小上限：自動降低品質或尺寸", async () => {
    const noisy = await sharp(Buffer.from(Array.from({ length: 1600 * 1200 * 3 }, () => (Math.random() * 255) | 0)), { raw: { width: 1600, height: 1200, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    const r = await processImage(noisy, "n.jpg", { maxKB: 150 });
    assert.ok(r.after <= 150 * 1024, `${r.after}`);
  });
  test("透明 PNG 轉 JPG 補白底；HEIC 與壞檔清楚說明，其餘照常處理", async () => {
    const t = await sharp({ create: { width: 50, height: 50, channels: 4, background: "#0000" } }).png().toBuffer();
    const j = await processImage(t, "t.png", { format: "jpg" });
    const px = await sharp(j.buf).raw().toBuffer();
    assert.ok(px[0] > 240, "透明處應為白色");
    const b = await batchImages(
      [
        { buf: t, name: "a.png" },
        { buf: t, name: "a.png" },
        { buf: Buffer.from("x"), name: "手機.heic" },
      ],
      { format: "webp" },
    );
    assert.deepEqual(b.results.map((x) => x.name), ["a.webp", "a-2.webp"]);
    assert.match(b.errors[0].error, /HEIC/);
    assert.match(b.markdown, /1 張失敗/);
    await assert.rejects(batchImages([{ buf: Buffer.from("x"), name: "壞.jpg" }]), /無法讀取為圖片/);
  });
});

describe("問卷分析", () => {
  const load = async () => parseTable("問卷回覆.csv", fs.readFileSync(path.join(FILES, "問卷回覆.csv")));
  test("題型判斷：時間、個資、單選、量表、複選、數值、開放題", async () => {
    const t = await load();
    const types = Object.fromEntries(classify(t.columns, t.rows).map((q) => [q.name, q.type]));
    assert.deepEqual(types, {
      時間戳記: "timestamp",
      電子郵件地址: "personal",
      姓名: "personal",
      系所: "single",
      整體滿意度: "scale",
      講者表現: "scale",
      "會推薦給同學嗎？": "single",
      "從哪裡得知活動？": "multi",
      年齡: "number",
      其他建議: "text",
    });
  });
  test("統計正確：百分比、平均、複選以填答人數為分母、分組比較", async () => {
    const t = await load();
    const a = analyzeSurvey(t, { group: "系所" });
    assert.equal(a.total, t.rows.length);
    const sat = a.questions.find((q) => q.name === "整體滿意度");
    const nums = t.rows.map((r) => Number(r["整體滿意度"])).filter((x) => x);
    assert.equal(sat.mean, Math.round((nums.reduce((x, y) => x + y, 0) / nums.length) * 100) / 100);
    assert.equal(sat.options.reduce((x, o) => x + o.n, 0), nums.length);
    assert.deepEqual(sat.options.map((o) => o.label), ["1", "2", "3", "4", "5"]);
    const multi = a.questions.find((q) => q.type === "multi");
    const web = multi.options.find((o) => o.label === "學校網站");
    assert.equal(web.n, t.rows.filter((r) => r["從哪裡得知活動？"].includes("學校網站")).length);
    assert.equal(web.pct, Math.round((web.n / multi.answered) * 1000) / 10);
    assert.ok(a.groups.tables.some((x) => x.question === "整體滿意度"));
    assert.deepEqual(a.personal, ["電子郵件地址", "姓名"]);
  });
  test("送給 AI 的資料不含個資", async () => {
    const t = await load();
    const a = analyzeSurvey(t);
    const sent = statsForAI(a) + openAnswersForAI(a);
    assert.ok(!/@example\.edu\.tw|王同學/.test(sent));
    assert.match(openAnswersForAI(a), /希望增加晚上的場次/);
  });
  test("圖表為 PNG、報告含表標題在上與圖說；Word 嵌入圖片；Excel 有三個工作表", async () => {
    const t = await load();
    const a = analyzeSurvey(t, { group: "系所" });
    const md = surveyMarkdown(a, { title: "測試" });
    assert.match(md, /表1 系所\n\n\| 選項 \| 人數 \| 百分比 \|/);
    assert.match(md, /!\[圖1 系所\]\(chart:\d+\)/);
    const images = {};
    for (const [i, q] of a.questions.entries()) {
      const svg = chartFor(q);
      if (!svg) continue;
      assert.ok(!/NaN|undefined/.test(svg), q.name);
      const png = await svgToPng(svg);
      const m = await sharp(png).metadata();
      images[`chart:${i}`] = { data: png, width: m.width / 2, height: m.height / 2 };
    }
    assert.equal(Object.keys(images).length, 6);
    const docx = await markdownToDocx(md, { images });
    const zip = await JSZip.loadAsync(docx);
    assert.equal(Object.keys(zip.files).filter((f) => f.startsWith("word/media/")).length, 6);
    const wb = await (async () => {
      const E = (await import("exceljs")).default;
      const w = new E.Workbook();
      await w.xlsx.load(await surveyXlsx(a));
      return w;
    })();
    assert.deepEqual(wb.worksheets.map((w) => w.name), ["統計結果", "開放題意見", "分組比較"]);
  });
});

describe("報告格式檢查", () => {
  const good = () => fs.readFileSync(path.join(FILES, "報告-符合規範.docx"));
  const bad = () => fs.readFileSync(path.join(FILES, "報告-格式錯誤.docx"));
  const fails = (r) => r.results.filter((x) => x.status === "未通過");
  test("符合規範的報告：判斷為學術型，沒有未通過項目", async () => {
    const r = await checkDocx(good());
    assert.equal(r.type, "academic");
    assert.deepEqual(fails(r).map((x) => x.item + "：" + x.detail), []);
  });
  test("格式錯誤的報告：找出字型、字級、對齊、標號、圖表、用語、參考文獻問題", async () => {
    const r = await checkDocx(bad(), "academic");
    const f = fails(r).map((x) => `${x.group}／${x.item}：${x.detail}`).join("\n");
    for (const re of [/新細明體|標楷體/, /11/, /兩端對齊|對齊/, /表標題|表格上方/, /口語|我們|大概/, /破折號/, /全形|１２３/, /Abstract|英文摘要/, /參考文獻/, /本研究.*本計畫|自稱/]) assert.match(f, re, `應檢查出：${re}`);
    const md = resultsToMarkdown(r, "檢查");
    assert.match(md, /\| 檢查項目 \|/);
  });
  test("自動修正：字型、字級、對齊、全形數字修正後，未通過項目減少，原檔不變", async () => {
    const src = bad();
    const before = fails(await checkDocx(src, "academic")).length;
    const fixed = await fixDocx(src);
    assert.ok(fixed.changedParagraphs > 0);
    const after = await checkDocx(fixed.buf, "academic");
    assert.ok(fails(after).length < before, `${before} → ${fails(after).length}`);
    const items = fails(after).map((x) => x.item).join("、");
    assert.ok(!/內文字型|內文字級|內文對齊/.test(items), items);
    assert.ok(!/１２３/.test(after.text));
    assert.deepEqual(src, bad());
  });
  test("不是 Word 檔時清楚說明", async () => {
    await assert.rejects(checkDocx(Buffer.from("not a zip")), /Word|docx/);
  });
});

describe("長錄音分段（ffmpeg）", { skip: !findFfmpeg() && "沒有 ffmpeg" }, () => {
  const tone = (sec, ext = "wav") => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tone-")), "t." + ext);
    const r = spawnSync(findFfmpeg(), ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=440:duration=${sec}`, "-ar", "16000", "-ac", "1", out]);
    assert.equal(r.status, 0, String(r.stderr));
    return fs.readFileSync(out);
  };
  test("小檔不需處理時原封不動", async () => {
    const buf = tone(2);
    const r = await prepareAudio(buf, ".wav", { limitBytes: 10 * 1024 * 1024 });
    assert.equal(r.converted, false);
    assert.equal(r.chunks[0].buf, buf);
  });
  test("轉成單聲道 16 kHz MP3，檔案大幅縮小", async () => {
    const buf = tone(20);
    const r = await prepareAudio(buf, ".wav", { limitBytes: 10 * 1024 * 1024, force: true });
    assert.equal(r.chunks.length, 1);
    assert.ok(r.chunks[0].buf.length < buf.length / 4);
    assert.ok(Math.abs(r.duration - 20) < 0.5);
  });
  test("超過上限時切段，各段時間位移正確", async () => {
    const logs = [];
    const r = await prepareAudio(tone(150), ".wav", { limitBytes: 300 * 1024, signal: undefined, log: (m) => logs.push(m) });
    assert.ok(r.chunks.length >= 2, `${r.chunks.length} 段`);
    assert.equal(r.chunks[0].offset, 0);
    assert.ok(Math.abs(r.chunks[1].offset - 60) < 1.5, String(r.chunks[1].offset));
    for (const c of r.chunks) assert.ok(c.buf.length <= 300 * 1024);
    assert.match(logs.join("\n"), /切成每段約 1 分鐘/);
    const d = path.join(os.tmpdir(), "seg-check.mp3");
    fs.writeFileSync(d, r.chunks.at(-1).buf);
    assert.ok((await probeDuration(d)) > 20);
  });
  test("不是音訊的檔案：清楚的錯誤訊息", async () => {
    await assert.rejects(prepareAudio(Buffer.alloc(1000, 1), ".mp3", { limitBytes: 10, force: true }), /音檔處理失敗/);
  });
});

// ======================= 新增：論文對照翻譯、圖表、報告排版、合併列印 =======================
import { makePaper } from "./helpers.js";
import { extractLayout, buildTranslatedPdf, translateBlocks, shouldTranslate, wrapText, fitText } from "../lib/pdftranslate.js";
import { parseFlow, parseOutline, parseGantt, renderDiagram, parseDate, svgToPng as diagramPng } from "../lib/diagram.js";
import { parseDraft, organize, buildReport, cnNumber } from "../lib/reportbuild.js";
import { mailMerge, loadTemplate, toChineseAmount, formatValue } from "../lib/mailmerge.js";
import { parseDocument } from "../lib/docs.js";

describe("論文 PDF 對照翻譯（版面分析與排版）", () => {
  test("段落辨識：雙欄分開、標題獨立、公式與頁碼不翻、參考文獻之後不翻", async () => {
    const lay = await extractLayout(await makePaper(2));
    const p1 = lay.pages[0].blocks;
    const title = p1.find((b) => /^Meshless Methods/.test(b.text));
    assert.ok(title?.translate && title.lines.length === 1);
    const left = p1.filter((b) => b.x0 < 100 && b.lines.length > 3);
    const right = p1.filter((b) => b.x0 > 300 && b.lines.length > 3);
    assert.equal(left.length, 3, "左欄 3 段");
    assert.equal(right.length, 3, "右欄 3 段");
    assert.ok(left.every((b) => b.x1 < 300), "左欄段落不應跨到右欄");
    // 閱讀順序：左欄全部在右欄之前
    const order = p1.filter((b) => b.lines.length > 3).map((b) => (b.x0 < 300 ? "L" : "R")).join("");
    assert.equal(order, "LLLRRR", order);
    const eq = p1.find((b) => /u \( x , t \)/.test(b.text));
    assert.equal(eq.translate, false, "公式不翻");
    assert.equal(p1.find((b) => b.text === "1").translate, false, "頁碼不翻");
    const p2 = lay.pages[1].blocks;
    assert.equal(p2.find((b) => b.text === "References").translate, false);
    assert.equal(p2.find((b) => /Iverson/.test(b.text)).translate, false, "參考文獻不翻");
    // 行尾連字號接回、段落文字完整
    assert.ok(left[0].text.split(" ").length > 30);
  });
  test("頁碼範圍與錯誤：超出範圍、掃描檔", async () => {
    const lay = await extractLayout(await makePaper(3), { pages: "2-3" });
    assert.deepEqual(lay.pages.map((p) => p.index), [1, 2]);
    await assert.rejects(extractLayout(await makePaper(1), { pages: "5" }), /超出範圍/);
    await assert.rejects(extractLayout(fs.readFileSync(path.join(FILES, "掃描檔.pdf"))), /掃描/);
  });
  test("判斷是否翻譯", () => {
    assert.equal(shouldTranslate("The meshless method is accurate."), true);
    assert.equal(shouldTranslate("x = 2 y + 3 z"), false);
    assert.equal(shouldTranslate("12"), false);
    assert.equal(shouldTranslate("本研究使用無網格法"), false, "已是中文");
    assert.equal(shouldTranslate("本研究使用無網格法", "en"), true);
  });
  test("斷行與字級：中文逐字、英文不切單字；放不下時縮小字級", () => {
    const lines = wrapText("無網格法（meshless method）可避免網格", 8);
    assert.ok(lines.every((l) => !/meshle$|^ss/.test(l)));
    const big = fitText("很長的譯文".repeat(40), 200, 40, 10);
    assert.ok(big.size < 10 && big.lines.length * big.size * 1.25 <= 40 * 1.08 + big.size * 0.3);
  });
  test("產生 PDF：左右對照頁寬加倍、只有譯文與交錯的頁數正確，譯文確實畫上", async () => {
    const buf = await makePaper(2);
    const lay = await extractLayout(buf);
    for (const p of lay.pages) for (const b of p.blocks) if (b.translate) b.out = "這是譯文段落，使用無網格法求解地下水流問題。";
    const side = await PDFDocument.load(await buildTranslatedPdf(buf, lay, { layout: "side" }));
    assert.equal(side.getPageCount(), 2);
    assert.equal(Math.round(side.getPage(0).getWidth()), 1190);
    assert.equal((await PDFDocument.load(await buildTranslatedPdf(buf, lay, { layout: "only" }))).getPageCount(), 2);
    const inter = await buildTranslatedPdf(buf, lay, { layout: "interleave" });
    assert.equal((await PDFDocument.load(inter)).getPageCount(), 4);
    if (pdftoppm) {
      // 譯文頁（交錯的第 2 頁）與原文頁不同：原文段落被蓋掉、換上譯文
      const a = await inkRatio(inter, 1);
      const b = await inkRatio(inter, 2);
      assert.ok(Math.abs(a - b) > 0.005, `${a} vs ${b}`);
    }
  });
});

describe("圖表產生", () => {
  test("流程圖寫法：串接、條件標籤、判斷與起訖形狀", () => {
    const f = parseFlow("開始 -> 填表 -> 審核？\n審核？ -[通過]-> 核發 -> 結束\n審核？ --退回--> 填表");
    assert.deepEqual(f.nodes.map((n) => [n.label, n.shape]), [["開始", "terminal"], ["填表", "process"], ["審核？", "decision"], ["核發", "process"], ["結束", "terminal"]]);
    assert.equal(f.edges.length, 5);
    assert.deepEqual(f.edges.filter((e) => e.label).map((e) => e.label), ["通過", "退回"]);
    assert.throws(() => parseFlow("\n\n"), /沒有讀到任何步驟/);
  });
  test("大綱：空白縮排、Tab、清單符號、Markdown 標題都可以", () => {
    const t = parseOutline("校長\n  教務處\n    註冊組\n\t學務處\n  - 總務處");
    assert.equal(t.text, "校長");
    assert.deepEqual(t.children.map((c) => c.text), ["教務處", "學務處", "總務處"]);
    // 多個最上層項目：以空白根節點包住
    assert.deepEqual(parseOutline("甲\n乙").children.map((c) => c.text), ["甲", "乙"]);
    const m = parseOutline("# 研究\n## 方法\n### 模擬\n## 成果");
    assert.deepEqual([m.text, m.children.map((c) => c.text), m.children[0].children[0].text], ["研究", ["方法", "成果"], "模擬"]);
  });
  test("甘特圖：西元、民國、天數、週、月、接續、分組；錯誤提示", () => {
    assert.equal(parseDate("115/3/5").toISOString().slice(0, 10), "2026-03-05");
    assert.equal(parseDate("2026年3月5日").toISOString().slice(0, 10), "2026-03-05");
    const t = parseGantt("第一階段：\n文獻, 2026-02-01, 10天\n問卷, 接續, 2週\n第二階段：\n分析, 115/4/1, 2個月\n期中報告, 2026-06-30");
    const d = (x) => x.toISOString().slice(0, 10);
    assert.deepEqual(t.map((x) => [x.section, x.name, d(x.start), d(x.end)]), [
      ["第一階段", "文獻", "2026-02-01", "2026-02-10"],
      ["第一階段", "問卷", "2026-02-11", "2026-02-24"],
      ["第二階段", "分析", "2026-04-01", "2026-05-31"],
      ["第二階段", "期中報告", "2026-06-30", "2026-06-30"],
    ]);
    assert.equal(t[3].milestone, true);
    assert.throws(() => parseGantt("文獻, 明天, 3天"), /開始日期「明天」無法辨識/);
    assert.throws(() => parseGantt("文獻, 2026-03-01, 2026-02-01"), /早於開始日期/);
  });
  test("四種圖都能轉成 PNG，SVG 不含 NaN，中文正確跳脫", async () => {
    const cases = {
      flow: "開始 -> A&B 審核？ -[是]-> 結束",
      org: "中心\n  甲組\n  乙組\n  丙組\n  丁組\n  戊組\n  己組",
      mind: "主題\n  分支一\n    細項\n  分支二\n  分支三",
      gantt: "工作 <1>, 2026-01-01, 2026-03-31\n工作二, 接續, 1個月",
    };
    for (const [k, v] of Object.entries(cases)) {
      const svg = renderDiagram(k, v, { title: "測試" });
      assert.ok(!/NaN|undefined/.test(svg), k);
      assert.ok(!/<1>/.test(svg) && (k !== "flow" || /A&amp;B/.test(svg)), "應跳脫特殊字元");
      const m = await sharp(await diagramPng(svg)).metadata();
      assert.ok(m.width > 200 && m.height > 100, `${k} ${m.width}x${m.height}`);
    }
  });
});

describe("報告自動排版", () => {
  const draft = () => fs.readFileSync(path.join(FILES, "報告草稿.md"), "utf8");
  test("解析：標題、表、圖、圖表標題、參考文獻", () => {
    const b = parseDraft(draft());
    assert.ok(b.some((x) => x.kind === "caption" && x.label === "表" && x.oldNo === "2"));
    assert.ok(b.some((x) => x.kind === "caption" && x.label === "圖" && x.oldNo === "3"));
    assert.equal(b.filter((x) => x.kind === "table").length, 2);
    assert.equal(b.filter((x) => x.kind === "image").length, 1);
  });
  test("整理：章節編號、圖標題移到圖下、依章重新編號、參考文獻排序", () => {
    const o = organize(parseDraft(draft()));
    const hs = o.blocks.filter((x) => x.kind === "heading").map((x) => x.text);
    assert.deepEqual(hs.slice(0, 5), ["第一章 緒論", "第一節 研究背景", "第二節 研究目的", "一、建立模型", "第二章 文獻回顧"]);
    assert.equal(o.map.get("表2").newNo, "1-1");
    assert.equal(o.map.get("圖3").newNo, "1-1");
    assert.equal(o.map.get("表5").newNo, "2-1");
    const img = o.blocks.find((x) => x.kind === "image");
    assert.equal(img.caption.title, "收斂曲線");
    assert.match(o.refs[0], /^劉芷妤/);
    assert.match(o.refs[1], /^Atluri/);
    assert.match(o.refs[2], /^Iverson/);
    assert.ok(o.refs.every((r) => !/^\[?\d/.test(r)), "原本的序號應去除");
    assert.deepEqual(o.missing, ["附錄"]);
    assert.equal(cnNumber(12), "十二");
    assert.equal(cnNumber(21), "二十一");
  });
  test("產生的 Word 通過所有格式檢查；圖表用 SEQ、引用用 REF 功能變數、內文全形標點", async () => {
    const r = await buildReport(draft(), { cover: { title: "測試報告", number: "NSTC 114-0000" } });
    const c = await checkDocx(r.buf);
    assert.deepEqual(c.results.filter((x) => x.status === "未通過" || x.status === "提醒").map((x) => `${x.item}：${x.detail}`), []);
    const xml = await (await JSZip.loadAsync(r.buf)).file("word/document.xml").async("string");
    assert.match(xml, /SEQ 表 \\r 1/);
    assert.match(xml, /REF _Ref_tab_1_1 \\h/);
    assert.match(xml, /TOC \\h \\c &quot;圖&quot;|TOC \\c &quot;圖&quot;/);
    assert.equal((xml.match(/<w:drawing>/g) || []).length, 1, "圖片應保留");
    const text = (await parseDocument("r.docx", r.buf)).text;
    assert.match(text, /本研究探討無網格法於地下水問題之應用，結果顯示計算效率提升約30%。/);
    // 功能變數的顯示文字（mammoth 不讀功能變數，直接看 XML）
    const plain = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");
    assert.match(plain, /如表1-1所示，收斂情形詳見圖1-1/);
    assert.match(plain, /表1-1 數值結果比較/);
    assert.match(plain, /各方法比較如表2-1/);
    assert.match(text, /NSTC 114-0000/);
    assert.ok(text.indexOf("參考文獻") < text.indexOf("附錄"));
  });
  test("計畫成果型：壹、一、（一）；Word 草稿（含圖片）也可以", async () => {
    const docxDraft = await markdownToDocx(draft().replace(/^# 結論與建議/m, "# 成果自評\n\n本計畫成果良好。\n\n# 結論與建議").replace(/本研究/g, "本計畫"), {
      images: {},
    });
    const r = await buildReport(draft().replace(/本研究/g, "本計畫"), { type: "project", cover: { title: "成果報告" } });
    const text = (await parseDocument("r.docx", r.buf)).text;
    assert.match(text, /壹、緒論/);
    assert.match(text, /一、研究背景/);
    assert.match(text, /（一）建立模型/);
    assert.ok(docxDraft.length > 1000);
  });
  test("沒有內文時提示", async () => {
    await assert.rejects(buildReport("# 緒論\n# 結論"), /草稿沒有內文/);
  });
});

describe("合併列印", () => {
  const tplBuf = () => fs.readFileSync(path.join(FILES, "獎狀範本.docx"));
  const load = async () => parseTable("獎狀名單.xlsx", fs.readFileSync(path.join(FILES, "獎狀名單.xlsx")));
  test("讀出範本欄位（含被拆開的 run 與 MERGEFIELD）", async () => {
    const t = await loadTemplate(tplBuf());
    assert.deepEqual(t.fields.sort(), ["姓名", "日期", "獎金", "獎項", "系所"].sort());
  });
  test("每人一份：檔名、內文、頁首、表格、民國日期、國字金額、MERGEFIELD 都正確；移除資料來源設定", async () => {
    const r = await mailMerge(tplBuf(), await load(), { filename: "獎狀-{{姓名}}" });
    assert.equal(r.count, 3, "空白列應略過");
    const zip = await JSZip.loadAsync(r.buf);
    assert.deepEqual(Object.keys(zip.files).sort(), ["獎狀-李美華.docx", "獎狀-王小明.docx", "獎狀-陳志強.docx"].sort());
    const one = await zip.file("獎狀-陳志強.docx").async("nodebuffer");
    const text = (await parseDocument("a.docx", one)).text.replace(/\*\*/g, "");
    assert.match(text, /河海工程學系 陳志強 同學/);
    assert.match(text, /榮獲 佳作/);
    assert.match(text, /新臺幣 參仟伍佰元整（3,500 元）/);
    assert.match(text, /中華民國 115年3月6日/);
    assert.ok(!/\{\{|«|»|MERGEFIELD/.test(text));
    const oz = await JSZip.loadAsync(one);
    assert.match(await oz.file("word/header1.xml").async("string"), /受獎人：陳志強/);
    assert.ok(!/mailMerge/.test(await oz.file("word/settings.xml").async("string")));
    // 範本中只有「姓名」兩字是粗體：代入後的姓名保留粗體
    assert.match(await oz.file("word/document.xml").async("string"), /<w:b\/><w:bCs\/><w:sz w:val="32"\/><w:szCs w:val="32"\/><\/w:rPr><w:t xml:space="preserve">陳志強<\/w:t>/);
  });
  test("合併成一個 Word：每人一頁，以分頁隔開", async () => {
    const r = await mailMerge(tplBuf(), await load(), { mode: "combined" });
    const xml = await (await JSZip.loadAsync(r.buf)).file("word/document.xml").async("string");
    assert.equal((xml.match(/<w:br w:type="page"\/>/g) || []).length, 2);
    assert.equal((xml.match(/<w:sectPr\b/g) || []).length, 1);
    const text = (await parseDocument("a.docx", r.buf)).text.replace(/\*\*/g, "");
    for (const n of ["王小明", "李美華", "陳志強"]) assert.match(text, new RegExp(`${n} 同學`));
  });
  test("欄位對不上、範本沒有欄位、XML 特殊字元", async () => {
    await assert.rejects(mailMerge(tplBuf(), { columns: ["姓名"], rows: [{ 姓名: "甲" }] }), /找不到：「系所」/);
    const plain = await markdownToDocx("沒有欄位的文件");
    await assert.rejects(mailMerge(plain, { columns: ["姓名"], rows: [{ 姓名: "甲" }] }), /沒有找到任何欄位/);
    const t = await load();
    t.rows[0].姓名 = "A&B <公司>";
    const r = await mailMerge(tplBuf(), t, { mode: "combined" });
    const x = await (await JSZip.loadAsync(r.buf)).file("word/document.xml").async("string");
    assert.match(x, /A&amp;B &lt;公司&gt;/);
  });
  test("金額國字與格式", () => {
    assert.equal(toChineseAmount(100000001), "壹億零壹元整");
    assert.equal(toChineseAmount(10500), "壹萬零伍佰元整");
    assert.equal(formatValue("2026-03-05", "民國"), "115年3月5日");
    assert.equal(formatValue("1234567", "千分位"), "1,234,567");
    assert.equal(formatValue("abc", "千分位"), "abc");
  });
});

// ======================= 新增：參考文獻查核、簡報、名單整理 =======================
import { startScholarMock } from "./fixtures.js";
import { parseOutline as parseDeckOutline, sanitizeDeck, buildPptx, deckToMarkdown } from "../lib/slides.js";
import { normalize, compareLists, mergeLists, dedupe, splitBy, compareReport, guessKey } from "../lib/listtools.js";

describe("參考文獻查核", () => {
  test("拆出每筆文獻：編號跨行、整份文件中找參考文獻章節", async () => {
    const R = await import("../lib/refcheck.js");
    const list = R.splitReferences(R.extractReferenceSection(fs.readFileSync(path.join(FILES, "參考文獻清單.txt"), "utf8")));
    assert.equal(list.length, 6);
    assert.match(list[2], /computational mechanics\. Computational Mechanics, 22\(2\)/, "跨行的文獻應接回同一筆");
    const doc = "# 緒論\n內文 (Iverson, 1997)。\n\n# 參考文獻\n\n1. Iverson, R. M. (1997). The physics of debris flows. Reviews of Geophysics, 35(3), 245-296.\n\n# 附錄\n\n會議紀錄";
    assert.deepEqual(R.splitReferences(R.extractReferenceSection(doc)), ["Iverson, R. M. (1997). The physics of debris flows. Reviews of Geophysics, 35(3), 245-296."]);
  });
  test("解析 APA／IEEE：年份、標題、第一作者、卷期頁碼；DOI 擷取", async () => {
    const R = await import("../lib/refcheck.js");
    const p = R.parseReference("Atluri, S. N., & Zhu, T. (1998). A new meshless local Petrov-Galerkin approach. Computational Mechanics, 22(2), 117-127.");
    assert.deepEqual([p.year, p.firstAuthor, p.volume, p.issue, p.pages], ["1998", "Atluri", "22", "2", "117-127"]);
    assert.match(p.title, /^A new meshless local Petrov-Galerkin approach$/);
    const q = R.parseReference('S. N. Atluri and T. Zhu, "A new meshless local Petrov-Galerkin approach," Comput. Mech., vol. 22, no. 2, pp. 117-127, 1998.');
    assert.equal(q.title, "A new meshless local Petrov-Galerkin approach");
    assert.equal(q.year, "1998");
    assert.equal(R.extractDoi("... 245-296. https://doi.org/10.1029/97RG00426."), "10.1029/97RG00426");
    assert.equal(R.extractDoi("doi:10.1007/s004660050346, accessed"), "10.1007/s004660050346");
  });
  test("APA 格式：作者縮寫、& 連接、卷期頁碼與 DOI", async () => {
    const R = await import("../lib/refcheck.js");
    const apa = R.toApa({ authors: [{ family: "Ku", given: "Cheng-Yu" }, { family: "Liu", given: "Chein-Shan" }, { family: "Fan", given: "Chia Ming" }], year: "2018", title: "A method.", journal: "Engineering Analysis with Boundary Elements", volume: "87", issue: null, pages: "91-102", doi: "10.1016/x" });
    assert.equal(apa, "Ku, C.-Y., Liu, C.-S., & Fan, C. M. (2018). A method. Engineering Analysis with Boundary Elements, 87, 91-102. https://doi.org/10.1016/x");
  });
  test("查核：正確、有差異（年份頁碼、缺 DOI）、捏造、DOI 抄錯、DOI 屬於別篇、中文", async () => {
    const mock = await startScholarMock();
    const prev = process.env.SCHOLAR_CROSSREF_BASE;
    process.env.SCHOLAR_CROSSREF_BASE = mock.url + "/cr";
    try {
      const R = await import(`../lib/refcheck.js?t=${Date.now()}`);
      const res = await R.checkReferences(fs.readFileSync(path.join(FILES, "參考文獻清單.txt"), "utf8"), { delayMs: 0 });
      assert.deepEqual(res.map((r) => r.status), ["中文未查核", "正確", "有差異", "查無此文獻", "DOI 錯誤", "DOI 錯誤"]);
      assert.match(res[2].detail, /年份應為 1998（文獻寫 1999）；頁碼應為 117-127（文獻寫 117-130）；缺少 DOI（10\.1007\/s004660050346）/);
      assert.match(res[4].detail, /正確 DOI 為 10\.1016\/j\.enganabound\.2017\.10\.009/);
      assert.match(res[5].detail, /對應的是另一篇文獻：「The physics of debris flows」/);
      assert.equal(res[5].apa, undefined, "DOI 屬於別篇時不可拿別篇當修正結果");
      const fixed = R.correctedList(res);
      assert.match(fixed[0], /^劉芷妤/);
      assert.ok(fixed.some((x) => /^【待查證】Smith/.test(x)));
      assert.ok(fixed.some((x) => /^Atluri, S\. N\., & Zhu, T\. \(1998\)\..*117-127\. https:\/\/doi\.org\/10\.1007\/s004660050346$/.test(x)));
      const md = R.refcheckMarkdown(res);
      assert.match(md, /共 6 筆：查無此文獻 1 筆、DOI 錯誤 2 筆、有差異 1 筆、正確 1 筆、中文未查核 1 筆/);
      const wb = new (await import("exceljs")).default.Workbook();
      await wb.xlsx.load(await R.refcheckXlsx(res));
      assert.equal(wb.worksheets[0].rowCount, 7);
    } finally {
      process.env.SCHOLAR_CROSSREF_BASE = prev;
      mock.server.close();
    }
  });
  test("沒有文獻、Crossref 連不上時清楚說明", async () => {
    const prev = process.env.SCHOLAR_CROSSREF_BASE;
    process.env.SCHOLAR_CROSSREF_BASE = "http://127.0.0.1:9/cr";
    try {
      const R = await import(`../lib/refcheck.js?u=${Date.now()}`);
      await assert.rejects(R.checkReferences("   "), /沒有讀到任何文獻/);
      await assert.rejects(R.checkReferences("Iverson, R. M. (1997). The physics of debris flows. Reviews of Geophysics, 35(3), 245-296.", { delayMs: 0 }), /無法連線到 Crossref/);
    } finally {
      process.env.SCHOLAR_CROSSREF_BASE = prev;
    }
  });
});

describe("簡報產生", () => {
  const outline = `# 期末報告
王大明｜河海工程學系

## 研究背景
- 地下水是重要水資源
  - 占用水三分之一
- 傳統方法需建立網格
備註：先說明背景。

## 數值結果
| 方法 | 誤差 |
|---|---|
| 本方法 | 0.01 |

## 研究流程
\`\`\`flow
開始 -> 建模 -> 結束
\`\`\`

# 第二部分
`;
  test("大綱解析：標題、副標題、重點與子項目、表格、流程圖、章節頁、講稿", () => {
    const d = parseDeckOutline(outline);
    assert.equal(d.title, "期末報告");
    assert.equal(d.subtitle, "王大明｜河海工程學系");
    assert.deepEqual(d.slides.map((s) => s.type), ["bullets", "table", "diagram", "section"]);
    assert.deepEqual(d.slides[0].bullets.map((b) => b.level), [0, 1, 0]);
    assert.equal(d.slides[0].notes, "先說明背景。");
    assert.throws(() => parseDeckOutline(""), /沒有投影片/);
  });
  test("檢查 AI 結果：資料不完整的圖表、表格改為文字頁；數列最多 4 個", () => {
    const d = sanitizeDeck({ title: "x", slides: [{ type: "chart", title: "壞", chart: { kind: "bar", labels: ["a", "b"], series: [{ name: "s", values: [1] }] } }, { type: "chart", title: "多", chart: { kind: "line", labels: ["a"], series: Array.from({ length: 6 }, (_, i) => ({ name: "s" + i, values: [i] })) } }, { type: "table", title: "空" }, { title: "" }] });
    assert.deepEqual(d.slides.map((s) => s.type), ["bullets", "chart", "bullets"]);
    assert.equal(d.slides[1].chart.series.length, 4);
    assert.throws(() => sanitizeDeck({ slides: [] }), /沒有產生任何投影片/);
  });
  test("產生 .pptx：封面、每頁一張、原生圖表、流程圖圖片、講稿、結尾頁", async () => {
    const deck = sanitizeDeck({
      ...parseDeckOutline(outline),
      slides: [...parseDeckOutline(outline).slides, { type: "chart", title: "時間", chart: { kind: "bar", labels: ["甲", "乙"], series: [{ name: "秒", values: [12, 45] }] }, notes: "比較" }, { type: "twocol", title: "比較", left: ["a"], right: ["b"] }],
    });
    const buf = await buildPptx(deck, { presenter: "王大明", org: "海大", theme: "simple" });
    const zip = await JSZip.loadAsync(buf);
    const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
    assert.equal(slides.length, deck.slides.length + 2, "封面 + 內容 + 結尾");
    assert.equal(Object.keys(zip.files).filter((f) => /^ppt\/charts\/chart\d+\.xml$/.test(f)).length, 1);
    assert.ok(Object.keys(zip.files).some((f) => /^ppt\/media\/.*\.png$/.test(f)), "流程圖應為圖片");
    const notes = await Promise.all(Object.keys(zip.files).filter((f) => /notesSlide\d+\.xml$/.test(f)).map((f) => zip.file(f).async("string")));
    assert.ok(notes.some((n) => n.includes("先說明背景。")));
    const all = (await Promise.all(slides.map((f) => zip.file(f).async("string")))).join("");
    assert.match(all, /敬請指教/);
    assert.match(all, /地下水是重要水資源/);
    const text = (await parseDocument("deck.pptx", buf)).text;
    assert.match(text, /期末報告/);
    assert.match(deckToMarkdown(deck), /> 講稿：先說明背景。/);
  });
});

describe("名單整理與比對", () => {
  const load = async (n) => ({ name: n.replace(/\.\w+$/, ""), ...(await parseTable(n, fs.readFileSync(path.join(FILES, n)))) });
  test("正規化：全形、空白、大小寫、電話", () => {
    assert.equal(normalize("Ｂ１１００１"), "b11001");
    assert.equal(normalize(" B11003 "), "b11003");
    assert.equal(normalize("0912-345-678"), normalize("+886 912 345 678"));
    assert.equal(normalize(" ABC ", { loose: false }), "ABC");
  });
  test("比對：自動選學號、忽略格式差異；只在一份、資料不一致、名單內重複", async () => {
    const A = await load("全班名單.xlsx");
    const B = await load("已繳交名單.csv");
    assert.deepEqual(guessKey(A.columns, B.columns), ["學號"]);
    const r = compareLists(A, B);
    assert.deepEqual(r.onlyA.map((x) => x.姓名), ["李美華", "張家豪"]);
    assert.deepEqual(r.onlyB.map((x) => x.姓名), ["旁聽生"]);
    assert.equal(r.both.length, 3);
    assert.deepEqual(r.changed.map((c) => [c.a.學號, c.diffs.map((d) => d.col)]), [["B11004", ["Email"]]]);
    assert.equal(r.dupB.length, 1);
    // 不忽略格式時，全形學號與大小寫不同就對不上
    assert.equal(compareLists(A, B, { loose: false }).both.length, 1);
    const rep = await compareReport(A, B, r);
    const wb = new (await import("exceljs")).default.Workbook();
    await wb.xlsx.load(rep.xlsx);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ["只在「全班名單」", "只在「已繳交名單」", "兩份都有", "資料不一致", "名單內重複"]);
    assert.match(rep.markdown, /## 只在「全班名單」（例如：應繳未繳、未報到）\n\n- B11002（李美華）/);
  });
  test("指定欄位、欄位不存在、沒有共同欄位", async () => {
    const A = await load("全班名單.xlsx");
    const B = await load("已繳交名單.csv");
    assert.equal(compareLists(A, B, { keys: "姓名" }).both.length, 3);
    assert.throws(() => compareLists(A, B, { keys: "生日" }), /第一份名單找不到欄位：「生日」/);
    assert.throws(() => compareLists({ name: "a", columns: ["甲"], rows: [] }, { name: "b", columns: ["乙"], rows: [] }), /沒有相同名稱的欄位/);
  });
  test("合併、去除重複、分組", async () => {
    const A = await load("全班名單.xlsx");
    const B = await load("已繳交名單.csv");
    const m = mergeLists([A, B]);
    assert.equal(m.columns[0], "來源檔案");
    assert.ok(m.columns.includes("繳交時間") && m.columns.includes("系所"));
    assert.equal(m.rows.length, 10);
    const d = dedupe(m, { keys: "學號" });
    assert.deepEqual([d.kept.length, d.removed.length], [6, 4]);
    assert.equal(d.removed[0].與第幾筆重複, 1);
    assert.equal(dedupe(B).removed.length, 0, "整列比對時，繳交時間不同就不算重複");
    const g = splitBy(A, "系所");
    assert.deepEqual([...g].map(([k, v]) => [k, v.length]), [["河海工程學系", 3], ["資訊工程學系", 2]]);
    assert.throws(() => splitBy(A, "年級"), /找不到分組欄位「年級」/);
  });
});
