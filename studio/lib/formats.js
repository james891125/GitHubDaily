// 更多文件格式：PowerPoint、OpenDocument、EPUB、RTF、Email、舊版 Word、字幕檔，
// 以及透過 LibreOffice（若電腦上有安裝）轉換的舊版 Excel / PowerPoint。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import JSZip from "jszip";
import WordExtractor from "word-extractor";
import { simpleParser } from "mailparser";

const userError = (msg) => Object.assign(new Error(msg), { status: 422 });

const decodeXml = (s) =>
  String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
const cellText = (s) => decodeXml(String(s).replace(/<[^>]+>/g, "")).replace(/\|/g, "／").replace(/\s+/g, " ").trim();
const mdTable = (rows) => {
  if (!rows.length) return "";
  const w = Math.max(...rows.map((r) => r.length));
  const line = (r) => "| " + Array.from({ length: w }, (_, i) => r[i] ?? "").join(" | ") + " |";
  return [line(rows[0]), "|" + Array(w).fill("---").join("|") + "|", ...rows.slice(1).map(line)].join("\n");
};

async function openZip(buf, what) {
  try {
    return await JSZip.loadAsync(buf);
  } catch {
    throw userError(`無法讀取${what}：檔案可能已損毀或不是正確的格式`);
  }
}

// ---------------- PowerPoint (.pptx) ----------------
function drawingMlText(xml) {
  const parts = [];
  // 表格
  const withTables = xml.replace(/<a:tbl>([\s\S]*?)<\/a:tbl>/g, (_, t) => {
    const rows = [...t.matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/g)].map((r) => [...r[0].matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/g)].map((c) => cellText(c[0].replace(/<\/a:p>/g, " "))));
    parts.push({ table: mdTable(rows) });
    return `\u0000TABLE${parts.length - 1}\u0000`;
  });
  const out = [];
  for (const seg of withTables.split(/(\u0000TABLE\d+\u0000)/)) {
    const m = /\u0000TABLE(\d+)\u0000/.exec(seg);
    if (m) {
      out.push(parts[Number(m[1])].table);
      continue;
    }
    for (const p of seg.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)) {
      const t = [...p[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>|<a:br\/>/g)].map((x) => (x[0] === "<a:br/>" ? "\n" : decodeXml(x[1]))).join("");
      if (t.trim()) out.push(t.trim());
    }
  }
  return out.join("\n\n");
}

async function pptxToText(buf) {
  const zip = await openZip(buf, "PowerPoint 檔");
  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml/)[1]) - Number(b.match(/(\d+)\.xml/)[1]));
  if (!slides.length) throw userError("這個 PowerPoint 檔沒有投影片");
  const out = [];
  for (const [i, name] of slides.entries()) {
    const xml = await zip.file(name).async("string");
    let text = `## 第 ${i + 1} 張投影片\n\n${drawingMlText(xml)}`;
    // 講者備註（透過投影片的關聯檔找到對應的備註頁）
    const rels = zip.file(name.replace("slides/", "slides/_rels/") + ".rels");
    const notesTarget = rels && /Target="\.\.\/notesSlides\/([^"]+)"/.exec(await rels.async("string"))?.[1];
    if (notesTarget) {
      const notes = drawingMlText(await zip.file(`ppt/notesSlides/${notesTarget}`).async("string"))
        .split("\n\n")
        .filter((t) => !/^(\d+|<number>|‹#›)$/.test(t.trim()))
        .join("\n");
      if (notes.trim()) text += `\n\n> 講者備註：${notes.trim()}`;
    }
    out.push(text);
  }
  return { text: out.join("\n\n"), pages: slides.length };
}

// ---------------- OpenDocument (.odt / .ods / .odp) ----------------
function odfInline(s) {
  return decodeXml(
    String(s)
      .replace(/<text:s(?: text:c="(\d+)")?\/>/g, (_, n) => " ".repeat(Number(n) || 1))
      .replace(/<text:tab\/>/g, "\t")
      .replace(/<text:line-break\/>/g, "\n")
      .replace(/<[^>]+>/g, ""),
  );
}
function odfTable(xml, { maxCols = 50 } = {}) {
  const rows = [];
  for (const r of xml.matchAll(/<table:table-row\b([^>]*)>([\s\S]*?)<\/table:table-row>/g)) {
    const cells = [];
    for (const c of r[2].matchAll(/<table:(?:covered-)?table-cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:(?:covered-)?table-cell>)/g)) {
      const rep = Math.min(Number(/table:number-columns-repeated="(\d+)"/.exec(c[1])?.[1] || 1), maxCols);
      const v = [...(c[2] || "").matchAll(/<text:p\b[^>]*>([\s\S]*?)<\/text:p>|<text:p\b[^>]*\/>/g)].map((p) => odfInline(p[1] || "")).join(" ").replace(/\|/g, "／").trim();
      for (let k = 0; k < rep && cells.length < maxCols; k++) cells.push(v);
    }
    while (cells.length && cells.at(-1) === "") cells.pop();
    if (cells.length) rows.push(cells);
  }
  return mdTable(rows);
}
async function odfToText(buf, ext) {
  const zip = await openZip(buf, "OpenDocument 檔");
  const xml = await zip.file("content.xml")?.async("string");
  if (!xml) throw userError("OpenDocument 檔中找不到內容");
  const body = /<office:body>([\s\S]*)<\/office:body>/.exec(xml)?.[1] || xml;
  if (ext === ".ods") {
    const sheets = [...body.matchAll(/<table:table\b[^>]*table:name="([^"]*)"[^>]*>([\s\S]*?)<\/table:table>/g)];
    return { text: sheets.map((s) => `## 工作表：${decodeXml(s[1])}\n\n${odfTable(s[2])}`).join("\n\n") };
  }
  if (ext === ".odp") {
    const pages = [...body.matchAll(/<draw:page\b[^>]*>([\s\S]*?)<\/draw:page>/g)];
    return {
      text: pages
        .map((p, i) => {
          const main = p[1].replace(/<presentation:notes\b[\s\S]*?<\/presentation:notes>/g, "");
          // 投影片中的表格先轉成 Markdown 表格，其餘依序取出文字
          const paras = [...main.matchAll(/<table:table\b[\s\S]*?<\/table:table>|<text:(?:p|h)\b[^>]*>([\s\S]*?)<\/text:(?:p|h)>/g)]
            .map((x) => (x[0].startsWith("<table:table") ? odfTable(x[0]) : odfInline(x[1]).trim()))
            .filter(Boolean);
          const notes = [...(/<presentation:notes\b[\s\S]*?<\/presentation:notes>/.exec(p[1])?.[0] || "").matchAll(/<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g)]
            .map((x) => odfInline(x[1]).trim())
            .filter((t) => t && !/^(\d+|<number>|‹#›)$/.test(t));
          return `## 第 ${i + 1} 張投影片\n\n${paras.join("\n\n")}${notes.length ? `\n\n> 講者備註：${notes.join(" ")}` : ""}`;
        })
        .join("\n\n"),
      pages: pages.length,
    };
  }
  // .odt：依序輸出標題、段落、表格
  const out = [];
  const re = /<table:table\b[\s\S]*?<\/table:table>|<text:h\b([^>]*)>([\s\S]*?)<\/text:h>|<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g;
  for (const m of body.matchAll(re)) {
    if (m[0].startsWith("<table:table")) out.push(odfTable(m[0]));
    else if (m[0].startsWith("<text:h")) {
      const level = Math.min(Number(/text:outline-level="(\d)"/.exec(m[1])?.[1] || 1), 4);
      const t = odfInline(m[2]).trim();
      if (t) out.push("#".repeat(level) + " " + t);
    } else {
      const t = odfInline(m[3]).trim();
      if (t) out.push(t);
    }
  }
  return { text: out.join("\n\n") };
}

// ---------------- EPUB ----------------
async function epubToText(buf, htmlToMarkdown) {
  const zip = await openZip(buf, "EPUB 電子書");
  const container = await zip.file("META-INF/container.xml")?.async("string");
  const opfPath = container && /full-path="([^"]+)"/.exec(container)?.[1];
  if (!opfPath || !zip.file(opfPath)) throw userError("EPUB 檔結構不完整");
  const opf = await zip.file(opfPath).async("string");
  const dir = path.posix.dirname(opfPath);
  const manifest = Object.fromEntries([...opf.matchAll(/<item\b[^>]*>/g)].map((m) => [/id="([^"]+)"/.exec(m[0])?.[1], /href="([^"]+)"/.exec(m[0])?.[1]]));
  const spine = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => manifest[m[1]]).filter(Boolean);
  const title = cellText(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/.exec(opf)?.[1] || "");
  const chapters = [];
  for (const href of spine) {
    const f = zip.file(path.posix.join(dir === "." ? "" : dir, decodeURIComponent(href)));
    if (!f) continue;
    const html = await f.async("string");
    const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] || html;
    const md = htmlToMarkdown(body).trim();
    if (md) chapters.push(md);
  }
  return { text: (title ? `# ${title}\n\n` : "") + chapters.join("\n\n"), pages: chapters.length };
}

// ---------------- RTF ----------------
const CODEPAGES = { 950: "big5", 936: "gbk", 932: "shift_jis", 949: "euc-kr", 1252: "windows-1252", 65001: "utf-8" };
export function rtfToText(raw) {
  const src = raw.toString("latin1");
  if (!src.startsWith("{\\rtf")) throw userError("不是有效的 RTF 檔");
  const decoder = new TextDecoder(CODEPAGES[/\\ansicpg(\d+)/.exec(src)?.[1]] || "windows-1252");
  const skipDest = /^(fonttbl|colortbl|stylesheet|info|pict|object|header|footer|headerl|headerr|footerl|footerr|listtable|listoverridetable|rsidtbl|generator|xmlnstbl|themedata|colorschememapping|latentstyles|datastore|mmathPr|pgdsctbl)$/;
  let out = "";
  let bytes = [];
  const flush = () => {
    if (bytes.length) out += decoder.decode(Uint8Array.from(bytes));
    bytes = [];
  };
  const stack = [];
  let skip = false;
  let uc = 1;
  let pendingSkip = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "{") {
      stack.push({ skip, uc });
      if (src[i + 1] === "\\" && src[i + 2] === "*") skip = true;
      continue;
    }
    if (c === "}") {
      flush();
      ({ skip, uc } = stack.pop() || { skip: false, uc: 1 });
      continue;
    }
    if (c === "\\") {
      const n = src[i + 1];
      if (n === "'") {
        const hex = src.substr(i + 2, 2);
        i += 3;
        if (pendingSkip > 0) {
          pendingSkip--;
          continue;
        }
        if (!skip) bytes.push(parseInt(hex, 16));
        continue;
      }
      if (n === "\\" || n === "{" || n === "}") {
        if (!skip) {
          flush();
          out += n;
        }
        i++;
        continue;
      }
      const m = /^([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i + 1, i + 40));
      if (!m) {
        i++;
        continue;
      }
      i += m[0].length;
      const word = m[1];
      const arg = m[2] !== undefined ? Number(m[2]) : null;
      if (skipDest.test(word)) {
        skip = true;
        continue;
      }
      if (skip) continue;
      if (word === "uc") uc = arg ?? 1;
      else if (word === "u") {
        flush();
        out += String.fromCharCode(arg < 0 ? arg + 65536 : arg);
        pendingSkip = uc;
      } else if (word === "par" || word === "line" || word === "row") {
        flush();
        out += "\n";
      } else if (word === "tab" || word === "cell") {
        flush();
        out += "\t";
      }
      continue;
    }
    if (c === "\r" || c === "\n") continue;
    if (skip) continue;
    if (pendingSkip > 0) {
      pendingSkip--;
      continue;
    }
    flush();
    out += c;
  }
  flush();
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------- Email (.eml) ----------------
async function emlToText(buf, htmlToMarkdown) {
  const mail = await simpleParser(buf);
  const addr = (a) => (a?.value || []).map((x) => (x.name ? `${x.name} <${x.address}>` : x.address)).join(", ");
  const body = mail.text?.trim() || (mail.html ? htmlToMarkdown(mail.html) : "");
  const atts = (mail.attachments || []).map((a) => `- ${a.filename || "（未命名）"}（${Math.round((a.size || 0) / 1024)} KB）`);
  return {
    text: [`# ${mail.subject || "（無主旨）"}`, "", `- 寄件者：${addr(mail.from)}`, `- 收件者：${addr(mail.to)}`, mail.cc ? `- 副本：${addr(mail.cc)}` : null, mail.date ? `- 日期：${mail.date.toLocaleString("zh-TW", { hour12: false })}` : null, "", body, atts.length ? `\n## 附件\n\n${atts.join("\n")}` : null]
      .filter((l) => l !== null)
      .join("\n"),
  };
}

// ---------------- 舊版 Word (.doc) ----------------
async function docToText(buf) {
  try {
    const doc = await new WordExtractor().extract(buf);
    return { text: [doc.getBody(), doc.getFootnotes(), doc.getEndnotes()].filter((t) => t && t.trim()).join("\n\n---\n\n") };
  } catch {
    // 有些 .doc 其實是 RTF 或其他格式，交給 LibreOffice 處理
    return null;
  }
}

// ---------------- 字幕檔 ----------------
export function subtitlesToText(text) {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/^WEBVTT.*$/m, "")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^\d+$/.test(l.trim()) && !/-->/.test(l) && !/^(NOTE|STYLE|REGION)\b/.test(l))
    .map((l) => l.replace(/<[^>]+>/g, "").trim())
    .join("\n");
}

// ---------------- LibreOffice 轉檔（舊版 .xls / .ppt 等）----------------
export function findSoffice() {
  const candidates = [
    process.env.SOFFICE_PATH,
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/usr/bin/soffice",
    "/usr/local/bin/soffice",
    "/opt/homebrew/bin/soffice",
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["soffice"], { encoding: "utf8" });
  return which.status === 0 ? which.stdout.split(/\r?\n/)[0].trim() || null : null;
}

export async function convertWithOffice(buf, ext, target) {
  const soffice = findSoffice();
  if (!soffice) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-conv-"));
  try {
    const input = path.join(dir, "input" + ext);
    fs.writeFileSync(input, buf);
    await new Promise((resolve, reject) => {
      const p = spawn(soffice, ["--headless", "--norestore", `-env:UserInstallation=file://${dir.replace(/\\/g, "/")}/profile`, "--convert-to", target, "--outdir", dir, input], { stdio: "ignore" });
      const t = setTimeout(() => (p.kill(), reject(userError("LibreOffice 轉檔逾時"))), 90000);
      p.on("error", (e) => (clearTimeout(t), reject(e)));
      p.on("exit", () => (clearTimeout(t), resolve()));
    });
    const out = path.join(dir, "input." + target);
    return fs.existsSync(out) ? fs.readFileSync(out) : null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const LEGACY = { ".xls": ["xlsx", "Excel 97-2003（.xls）", "Excel 另存為 .xlsx"], ".ppt": ["pptx", "PowerPoint 97-2003（.ppt）", "PowerPoint 另存為 .pptx"], ".doc": ["docx", "Word 97-2003（.doc）", "Word 另存為 .docx"] };

/**
 * 解析新增的格式；不屬於這裡的格式回傳 undefined。
 * helpers：{ htmlToMarkdown, decodeText, parseDocument }
 */
export async function parseExtraFormat(ext, buf, helpers) {
  switch (ext) {
    case ".pptx":
      return { ...(await pptxToText(buf)), kind: "pptx" };
    case ".odt":
    case ".ods":
    case ".odp":
      return { ...(await odfToText(buf, ext)), kind: ext.slice(1) };
    case ".epub":
      return { ...(await epubToText(buf, helpers.htmlToMarkdown)), kind: "epub" };
    case ".rtf":
      return { text: rtfToText(buf), kind: "rtf" };
    case ".eml":
      return { ...(await emlToText(buf, helpers.htmlToMarkdown)), kind: "eml" };
    case ".msg":
      throw userError("Outlook 的 .msg 格式目前不支援：請在 Outlook 中將郵件「另存新檔」為 .eml（或 .txt）後再上傳");
    case ".srt":
    case ".vtt":
      return { text: subtitlesToText(helpers.decodeText(buf)), kind: ext.slice(1) };
    case ".xml":
    case ".tsv":
    case ".log":
    case ".yaml":
    case ".yml":
      return { text: helpers.decodeText(buf), kind: ext.slice(1) };
    case ".doc": {
      const r = await docToText(buf);
      if (r?.text?.trim()) return { ...r, kind: "doc" };
    }
    // fallthrough：交給 LibreOffice
    case ".xls":
    case ".ppt": {
      const [target, label, hint] = LEGACY[ext];
      const converted = await convertWithOffice(buf, ext, target);
      if (!converted) throw userError(`${label} 是舊版格式，需要轉檔才能讀取：請用 ${hint}，或在電腦安裝免費的 LibreOffice（https://www.libreoffice.org）後重試。`);
      const r = await helpers.parseDocument("converted." + target, converted);
      return { ...r, kind: ext.slice(1) };
    }
    default:
      return undefined;
  }
}

export const EXTRA_FORMATS = [".pptx", ".odt", ".ods", ".odp", ".epub", ".rtf", ".eml", ".srt", ".vtt", ".xml", ".tsv", ".log", ".yaml", ".yml", ".doc", ".xls", ".ppt"];
