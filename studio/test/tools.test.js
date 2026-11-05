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
