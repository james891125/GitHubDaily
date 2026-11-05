// 文件解析：PDF、Word(docx)、Excel(xlsx)、CSV、HTML、Markdown、純文字 → 純文字／Markdown
import path from "node:path";
import mammoth from "mammoth";
import ExcelJS from "exceljs";
import { createRequire } from "node:module";
import { htmlToMarkdown, decodeBody } from "./web.js";

// pdf.js 需要 CMap 與標準字型檔才能正確擷取中日韓文字
const require = createRequire(import.meta.url);
const PDFJS_DIR = path.dirname(require.resolve("pdfjs-dist/package.json"));
// pdf.js 規定路徑必須以「/」結尾；Windows 的 Node.js 也能讀取「C:/…/」這種寫法，因此統一轉成「/」
export const toPdfjsDir = (p, sep = path.sep) => p.split(sep).join("/").replace(/\/?$/, "/");
const CMAP_URL = toPdfjsDir(path.join(PDFJS_DIR, "cmaps"));
const FONT_URL = toPdfjsDir(path.join(PDFJS_DIR, "standard_fonts"));

export const SUPPORTED = [".pdf", ".docx", ".xlsx", ".csv", ".txt", ".md", ".markdown", ".html", ".htm", ".json"];

async function pdfToText(buf) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: FONT_URL,
    useSystemFonts: true,
    isEvalSupported: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  const numPages = doc.numPages;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // 依 y 座標換行，還原段落
    let lastY = null;
    let line = "";
    const lines = [];
    for (const it of content.items) {
      if (!("str" in it)) continue;
      const y = it.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        lines.push(line);
        line = "";
      }
      line += it.str;
      if (it.hasEOL) {
        lines.push(line);
        line = "";
        lastY = null;
        continue;
      }
      lastY = y;
    }
    if (line) lines.push(line);
    pages.push(`<!-- 第 ${i} 頁 -->\n` + lines.map((l) => l.trimEnd()).join("\n"));
  }
  await task.destroy();
  return { text: pages.join("\n\n"), pages: numPages };
}

async function xlsxToText(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const parts = [];
  wb.eachSheet((ws) => {
    const rows = [];
    ws.eachRow((row) => {
      const vals = row.values.slice(1).map((v) => {
        if (v === null || v === undefined) return "";
        if (typeof v === "object") return v.text ?? v.result ?? (v instanceof Date ? v.toISOString().slice(0, 10) : JSON.stringify(v));
        return String(v);
      });
      rows.push("| " + vals.map((x) => x.replace(/\|/g, "/").replace(/\n/g, " ")).join(" | ") + " |");
      if (rows.length === 1) rows.push("|" + vals.map(() => "---").join("|") + "|");
    });
    parts.push(`## 工作表：${ws.name}\n\n${rows.join("\n")}`);
  });
  return parts.join("\n\n");
}

/**
 * @param {string} filename
 * @param {Buffer} buf
 * @returns {Promise<{text:string, kind:string, pages?:number}>}
 */
export async function parseDocument(filename, buf) {
  if (!buf?.length) throw new Error("檔案是空的，沒有可處理的內容");
  const r = await parseDocumentInner(filename, buf);
  // Windows 的換行是 \r\n，統一成 \n，才能正確分段
  r.text = r.text.replace(/\r\n?/g, "\n");
  if (!r.text.replace(/<!--.*?-->/g, "").trim()) throw new Error("檔案中沒有可擷取的文字內容");
  return r;
}

async function parseDocumentInner(filename, buf) {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".pdf": {
      const r = await pdfToText(buf);
      if (r.text.replace(/<!--.*?-->|\s/g, "").length < 20) {
        throw new Error("此 PDF 幾乎沒有可擷取的文字（可能是掃描影像），目前不支援 OCR。");
      }
      return { ...r, kind: "pdf" };
    }
    case ".docx": {
      const { value } = await mammoth.convertToHtml({ buffer: buf });
      return { text: htmlToMarkdown(value), kind: "docx" };
    }
    case ".xlsx":
      return { text: await xlsxToText(buf), kind: "xlsx" };
    case ".html":
    case ".htm":
      return { text: htmlToMarkdown(decodeBody(buf)), kind: "html" };
    case ".csv":
    case ".txt":
    case ".md":
    case ".markdown":
    case ".json":
      return { text: decodeText(buf), kind: ext.slice(1) };
    default:
      throw new Error(`不支援的檔案格式：${ext || "（無副檔名）"}。支援：${SUPPORTED.join("、")}`);
  }
}

/**
 * 文字檔解碼：UTF-8（含 BOM）、UTF-16，或台灣 Windows 常見的 Big5（例如 Excel 另存的 CSV）
 */
export function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^\uFEFF/, "");
  } catch {
    return new TextDecoder("big5").decode(buf);
  }
}

/**
 * 依段落切塊（保留標題脈絡），每塊約 maxChars 字元。
 * @returns {Array<{text:string, heading:string, index:number}>}
 */
export function chunkText(text, { maxChars = 1200, overlap = 150 } = {}) {
  const paras = text.replace(/\r\n?/g, "\n").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let heading = "";
  let cur = "";
  let fresh = false; // cur 是否含有尚未輸出的新內容（不只是重疊部分）
  const push = () => {
    if (fresh && cur.trim()) chunks.push({ text: cur.trim(), heading, index: chunks.length });
    cur = cur.length > overlap ? cur.slice(-overlap) : cur;
    fresh = false;
  };
  const add = (s) => {
    cur += (cur ? "\n\n" : "") + s;
    fresh = true;
  };
  for (let p of paras) {
    const h = /^(#{1,6})\s+(.+)/.exec(p);
    if (h) heading = h[2].trim();
    while (p.length > maxChars) {
      // 超長段落：在句號處切開
      let cut = p.lastIndexOf("。", maxChars);
      if (cut < maxChars * 0.5) cut = p.lastIndexOf(". ", maxChars);
      if (cut < maxChars * 0.5) cut = maxChars;
      push();
      add(p.slice(0, cut + 1));
      push();
      p = p.slice(cut + 1).trim();
    }
    if (!p) continue;
    if (cur.length + p.length + 2 > maxChars) push();
    add(p);
  }
  push();
  return chunks;
}

/** 長文切成較大的段（給翻譯、摘要用），盡量在段落邊界切 */
export function splitForProcessing(text, maxChars = 6000) {
  const paras = text.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  const out = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > maxChars) {
      out.push(cur);
      cur = "";
    }
    if (p.length > maxChars) {
      for (let i = 0; i < p.length; i += maxChars) out.push(p.slice(i, i + maxChars));
      continue;
    }
    cur += (cur ? "\n\n" : "") + p;
  }
  if (cur) out.push(cur);
  return out;
}
