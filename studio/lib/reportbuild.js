// 報告自動排版：把草稿（Word、Markdown、純文字）排成符合國科會／計畫成果報告格式的 Word 檔。
// 依「報告撰寫規範」：標楷體＋Times New Roman、內文 12pt 兩端對齊固定行高 18pt、章標題 16pt 粗體、
// 節標題 14pt 粗體、圖表標題 14pt；表標題在上、圖標題在下，編號「表1-1」以 SEQ 功能變數產生，
// 內文引用以 REF 功能變數連結；自動目錄、圖目錄、表目錄；參考文獻加序號與懸掛縮排；開檔自動更新功能變數。
import mammoth from "mammoth";
import sharp from "sharp";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  AlignmentType,
  ImageRun,
  SimpleField,
  Bookmark,
  TableOfContents,
  Footer,
  PageNumber,
  HeadingLevel,
  LineRuleType,
} from "docx";
import { htmlToMarkdown } from "./web.js";
import { fixText } from "./formatcheck.js";

const EAST = "標楷體";
const ASCII = "Times New Roman";
const FONT = { ascii: ASCII, hAnsi: ASCII, eastAsia: EAST, cs: ASCII };
const BODY = 24; // 12pt
const LINE = { line: 360, lineRule: LineRuleType.EXACT }; // 固定行高 18pt（約 1.5 倍）

const CN = "零一二三四五六七八九十";
export function cnNumber(n) {
  if (n <= 10) return CN[n];
  if (n < 20) return "十" + (n % 10 ? CN[n % 10] : "");
  return CN[Math.floor(n / 10)] + "十" + (n % 10 ? CN[n % 10] : "");
}
const UPPER = "壹貳參肆伍陸柒捌玖拾";
const upperNum = (n) => (n <= 10 ? UPPER[n - 1] : "拾" + UPPER[(n % 10) - 1]);

const FRONT = /^(摘要|中文摘要|abstract|英文摘要|目錄|圖目錄|表目錄|謝誌|致謝)$/i;
const BACK = /^(參考文獻|references|bibliography|附錄.*|appendix.*)$/i;
const userError = (m) => Object.assign(new Error(m), { status: 422 });

// ---------------- 讀取草稿 ----------------
/** Word 檔轉 Markdown（保留圖片為 data URI、標題層級、表格） */
export async function docxToMarkdown(buf) {
  const { value } = await mammoth.convertToHtml(
    { buffer: buf },
    { convertImage: mammoth.images.imgElement((img) => img.read("base64").then((b) => ({ src: `data:${img.contentType};base64,${b}` }))) },
  );
  return htmlToMarkdown(value);
}

const MARK = {
  chapter: /^第([一二三四五六七八九十百]+)章\s*/,
  section: /^第([一二三四五六七八九十百]+)節\s*/,
  upper: /^[壹貳參肆伍陸柒捌玖拾]+、\s*/,
  cn: /^[一二三四五六七八九十]+、\s*/,
  paren: /^（[一二三四五六七八九十]+）\s*/,
};
const CAPTION = /^(?:\*\*)?(表|圖|Table|Figure|Fig\.)\s*(\d+(?:\s*[-－.]\s*\d+)?)?\s*[:：.、]?\s*(.*?)(?:\*\*)?$/i;

/**
 * 解析成結構化區塊：heading / para / table / image / caption / list / refs
 */
export function parseDraft(md, type = "academic") {
  const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  const looksHeading = (t) => t.length <= 40 && !/[。；，,.]$/.test(t);
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || /^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      i++;
      continue;
    }
    // 表格
    if (/^\|.*\|$/.test(line) && /^\|?\s*:?-{2,}/.test((lines[i + 1] || "").trim())) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim().replace(/<br\s*\/?>/gi, "\n"));
      const rows = [cells(line)];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      blocks.push({ kind: "table", rows });
      continue;
    }
    // 圖片
    const img = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/.exec(line);
    if (img) {
      blocks.push({ kind: "image", alt: img[1], src: img[2] });
      i++;
      continue;
    }
    // Markdown 標題
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    let text = (h ? h[2] : line).replace(/^\*\*(.*)\*\*$/, "$1").trim();
    let level = h ? Math.min(h[1].length, 4) : 0;
    if (!level && looksHeading(text)) {
      if (MARK.chapter.test(text) || FRONT.test(text.replace(/\s/g, "")) || BACK.test(text.replace(/\s/g, ""))) level = 1;
      else if (MARK.upper.test(text)) level = 1;
      else if (MARK.section.test(text)) level = 2;
    }
    if (level) {
      blocks.push({ kind: "heading", level, text });
      i++;
      continue;
    }
    // 圖表標題
    const cap = CAPTION.exec(text);
    if (cap && cap[3] && text.length <= 80 && (cap[2] || /^(表|圖)\s*[:：]/.test(text)) && !/[。]$/.test(text)) {
      blocks.push({ kind: "caption", label: /^(表|table)/i.test(cap[1]) ? "表" : "圖", oldNo: (cap[2] || "").replace(/\s/g, "").replace(/[－.]/g, "-"), title: cap[3].trim() });
      i++;
      continue;
    }
    // 清單
    const li = /^(\s*)([-*+]|\d+[.、)])\s+(.*)$/.exec(raw);
    if (li) {
      blocks.push({ kind: "list", ordered: /\d/.test(li[2]), marker: li[2], level: Math.min(Math.floor(li[1].length / 2), 3), text: li[3].trim() });
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) text = text.replace(/^>\s?/, "");
    blocks.push({ kind: "para", text });
    i++;
  }
  return blocks;
}

// ---------------- 整理結構 ----------------
const stripMark = (t) => t.replace(MARK.chapter, "").replace(MARK.section, "").replace(MARK.upper, "").replace(MARK.cn, "").replace(MARK.paren, "").trim();
const hasMark = (t) => Object.values(MARK).some((re) => re.test(t));

/**
 * 章節編號、圖表編號、引用對應、參考文獻排序
 * @returns {{ blocks, front: object, refs: string[], log: string[] }}
 */
export function organize(blocks, { type = "academic", autoNumber = true, sortRefs = true, fillMissing = true } = {}) {
  const log = [];
  // 1. 分出前置（摘要、Abstract）、參考文獻
  const out = [];
  const sections = { 摘要: null, Abstract: null };
  let refs = null;
  let cur = null;
  for (const b of blocks) {
    if (b.kind === "heading" && b.level === 1) {
      const t = b.text.replace(/\s/g, "");
      if (/^(中文)?摘要$/.test(t)) cur = sections.摘要 = [];
      else if (/^(abstract|英文摘要)$/i.test(t)) cur = sections.Abstract = [];
      else if (/^(目錄|圖目錄|表目錄)$/.test(t)) cur = []; // 舊目錄捨棄，改用自動目錄
      else if (/^(參考文獻|references|bibliography)$/i.test(t)) cur = refs = [];
      else (cur = null), out.push(b);
      continue;
    }
    if (cur) cur.push(b);
    else out.push(b);
  }
  // 2. 章節編號
  let ch = 0;
  let sec = 0;
  let h3 = 0;
  let h4 = 0;
  for (const b of out) {
    if (b.kind !== "heading") continue;
    const plain = stripMark(b.text);
    if (b.level === 1) {
      if (BACK.test(b.text.replace(/\s/g, "")) || FRONT.test(b.text.replace(/\s/g, ""))) {
        b.backMatter = true;
        continue;
      }
      ch++;
      sec = h3 = h4 = 0;
      b.chapter = ch;
      if (autoNumber && !hasMark(b.text)) b.text = type === "project" ? `${upperNum(ch)}、${plain}` : `第${cnNumber(ch)}章 ${plain}`;
    } else if (b.level === 2) {
      sec++;
      h3 = h4 = 0;
      if (autoNumber && !hasMark(b.text)) b.text = type === "project" ? `${cnNumber(sec)}、${plain}` : `第${cnNumber(sec)}節 ${plain}`;
    } else if (b.level === 3) {
      h3++;
      h4 = 0;
      if (autoNumber && !hasMark(b.text)) b.text = type === "project" ? `（${cnNumber(h3)}）${plain}` : `${cnNumber(h3)}、${plain}`;
    } else {
      h4++;
      if (autoNumber && !hasMark(b.text)) b.text = type === "project" ? `${h4}. ${plain}` : `（${cnNumber(h4)}）${plain}`;
    }
  }
  if (autoNumber) log.push(`章節編號：${ch} 章`);
  // 3. 圖表：標題位置（表在上、圖在下）與編號
  const fixed = [];
  for (let k = 0; k < out.length; k++) {
    const b = out[k];
    if (b.kind === "caption") {
      const next = out[k + 1];
      const prev = fixed.at(-1);
      if (b.label === "表" && next?.kind === "table") (next.caption = b), (b.used = true);
      else if (b.label === "圖" && next?.kind === "image" && !next.caption && !(prev?.kind === "image" && !prev.caption)) (next.caption = b), (b.used = true), log.push(`圖標題「${b.title}」移到圖的下方`);
      else if (b.label === "圖" && prev?.kind === "image" && !prev.caption) (prev.caption = b), (b.used = true);
      else if (b.label === "表" && prev?.kind === "table" && !prev.caption) (prev.caption = b), (b.used = true), log.push(`表標題「${b.title}」移到表格上方`);
      if (b.used) continue;
    }
    fixed.push(b);
  }
  // 沒有標題的圖：以替代文字當標題
  for (const b of fixed) if (b.kind === "image" && !b.caption && b.alt && !/^(image|圖片|img)\d*$/i.test(b.alt)) b.caption = { label: "圖", title: b.alt.replace(CAPTION, (m, l, n, t) => t || m), oldNo: (CAPTION.exec(b.alt)?.[2] || "").replace(/[－.]/g, "-") };
  const map = new Map(); // 舊編號 → 新編號（依章）
  const counters = {};
  let chap = 0;
  let firstChap = fixed.find((b) => b.kind === "heading" && b.chapter)?.chapter || 1;
  for (const b of fixed) {
    if (b.kind === "heading" && b.chapter) chap = b.chapter;
    if ((b.kind === "table" || b.kind === "image") && b.caption) {
      const c = chap || firstChap;
      const key = `${b.caption.label}${c}`;
      counters[key] = (counters[key] || 0) + 1;
      b.caption.chapter = c;
      b.caption.seq = counters[key];
      b.caption.newNo = `${c}-${counters[key]}`;
      b.caption.bookmark = `_Ref_${b.caption.label === "表" ? "tab" : "fig"}_${c}_${counters[key]}`;
      if (b.caption.oldNo) {
        map.set(`${b.caption.label}${b.caption.oldNo}`, b.caption);
        if (b.caption.oldNo !== b.caption.newNo) log.push(`${b.caption.label}${b.caption.oldNo} 重新編號為 ${b.caption.label}${b.caption.newNo}`);
      }
      // 也接受以新編號引用
      if (!map.has(`${b.caption.label}${b.caption.newNo}`)) map.set(`${b.caption.label}${b.caption.newNo}`, b.caption);
    }
  }
  const capCount = Object.values(counters).reduce((a, b) => a + b, 0);
  if (capCount) log.push(`圖表 ${capCount} 個，以功能變數重新編號`);
  // 4. 參考文獻
  let refList = (refs || [])
    .filter((b) => ["para", "list"].includes(b.kind))
    .map((b) => b.text.replace(/^\s*(\[\d+\]|\d+[.．、)]|［\d+］)\s*/, "").trim())
    .filter(Boolean);
  if (sortRefs && refList.length) {
    const zh = refList.filter((r) => /^[\u4e00-\u9fff]/.test(r)).sort((a, b) => a.localeCompare(b, "zh-Hant-TW-u-co-stroke"));
    const en = refList.filter((r) => !/^[\u4e00-\u9fff]/.test(r)).sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
    refList = [...zh, ...en];
    log.push(`參考文獻 ${refList.length} 筆：中文在前、英文在後，各自排序並加上序號`);
  }
  // 5. 必要章節
  const missing = [];
  if (fillMissing) {
    if (!sections.摘要) missing.push("摘要");
    if (!sections.Abstract) missing.push("Abstract");
    if (!refs) missing.push("參考文獻");
    const need = type === "project" ? [["前言", /前言|計畫主旨/], ["結論與建議", /結論/], ["成果自評", /成果自評|價值與貢獻/]] : [["緒論", /緒論|前言/], ["文獻回顧", /文獻(回顧|探討)/], ["結論與建議", /結論/]];
    for (const [n, re] of need) if (!fixed.some((b) => b.kind === "heading" && re.test(b.text))) missing.push(n);
    if (!fixed.some((b) => b.kind === "heading" && /^附錄/.test(b.text))) missing.push("附錄");
    if (missing.length) log.push(`缺少的章節：${missing.join("、")}（摘要、Abstract、參考文獻、附錄已加上「待填寫」提示；其他章節請自行補上）`);
  }
  return { blocks: fixed, sections, refs: refList, hasRefs: !!refs, map, missing, log };
}

// ---------------- 產生 Word ----------------
/** 行內：**粗體**、連結、`程式碼`；以及「表1-1」等引用轉成 REF 功能變數 */
function inlineRuns(text, map, { size = BODY, bold = false, normalize = true } = {}) {
  let t = String(text)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1（$2）")
    .replace(/`([^`]+)`/g, "$1");
  if (normalize) t = fixText(t).replace(/([\u4e00-\u9fff])\(([^()]*)\)/g, "$1（$2）");
  const out = [];
  const keys = map ? [...map.keys()].sort((a, b) => b.length - a.length) : [];
  const refRe = keys.length ? new RegExp(`(${keys.map((k) => k.replace(/([.-])/g, "\\$1").replace(/^(表|圖)/, "$1\\s*")).join("|")})(?![\\d-])`, "g") : null;
  for (const part of t.split(/(\*\*[^*]+\*\*)/g)) {
    if (!part) continue;
    const isBold = /^\*\*[^*]+\*\*$/.test(part);
    const body = isBold ? part.slice(2, -2) : part;
    let last = 0;
    if (refRe) {
      for (const m of body.matchAll(refRe)) {
        const cap = map.get(m[1].replace(/\s/g, ""));
        if (!cap) continue;
        if (m.index > last) out.push(new TextRun({ text: body.slice(last, m.index), bold: bold || isBold, font: FONT, size }));
        out.push(new SimpleField(`REF ${cap.bookmark} \\h`, `${cap.label}${cap.newNo}`));
        last = m.index + m[0].length;
      }
    }
    if (last < body.length) out.push(new TextRun({ text: body.slice(last), bold: bold || isBold, font: FONT, size }));
  }
  return out;
}

const bodyPara = (children, extra = {}) => new Paragraph({ children, alignment: AlignmentType.JUSTIFIED, spacing: { ...LINE, after: 120 }, indent: { firstLine: 480 }, ...extra });
const placeholder = (t) => bodyPara([new TextRun({ text: `（${t}：待填寫）`, font: FONT, size: BODY, color: "808080" })]);

function captionPara(cap) {
  return new Paragraph({
    style: "Caption",
    alignment: AlignmentType.CENTER,
    keepNext: cap.label === "表",
    spacing: { before: 120, after: 120 },
    children: [
      new Bookmark({ id: cap.bookmark, children: [new TextRun({ text: `${cap.label}${cap.chapter}-`, font: FONT, size: 28 }), new SimpleField(cap.seq === 1 ? `SEQ ${cap.label} \\r 1 \\* ARABIC` : `SEQ ${cap.label} \\* ARABIC`, String(cap.seq))] }),
      new TextRun({ text: " " + fixText(cap.title || ""), font: FONT, size: 28 }),
    ],
  });
}

function tableEl(rows, map) {
  const border = { style: BorderStyle.SINGLE, size: 4, color: "000000" };
  const width = Math.max(...rows.map((r) => r.length));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(
      (r, ri) =>
        new TableRow({
          tableHeader: ri === 0,
          children: Array.from({ length: width }, (_, ci) =>
            new TableCell({
              borders: { top: border, bottom: border, left: border, right: border },
              shading: ri === 0 ? { fill: "EDEDED" } : undefined,
              children: String(r[ci] ?? "")
                .split("\n")
                .map((t) => new Paragraph({ alignment: AlignmentType.CENTER, children: inlineRuns(t.replace(/\*\*/g, ri === 0 ? "" : "**"), map, { size: BODY, bold: ri === 0 }) })),
            }),
          ),
        }),
    ),
  });
}

async function imageEl(src) {
  const m = /^data:image\/([\w+.-]+);base64,(.+)$/.exec(src);
  if (!m) return null;
  let data = Buffer.from(m[2], "base64");
  let type = m[1].replace("jpeg", "jpg");
  let meta;
  try {
    meta = await sharp(data).metadata();
  } catch {
    return null; // EMF／WMF 等向量圖無法處理
  }
  if (!["png", "jpg", "gif", "bmp"].includes(type)) {
    data = await sharp(data).png().toBuffer();
    type = "png";
  }
  const maxW = 560; // 約 14.8 公分
  const w = Math.min(maxW, meta.width);
  // 圖片段落不可用固定行高，否則圖會被裁切
  return new Paragraph({ alignment: AlignmentType.CENTER, keepNext: true, spacing: { line: 240, lineRule: LineRuleType.AUTO, before: 120 }, children: [new ImageRun({ type, data, transformation: { width: w, height: Math.round((meta.height * w) / meta.width) } })] });
}

const titleStyle = (size) => ({ run: { font: FONT, size, bold: true, color: "000000" }, paragraph: { spacing: { before: 240, after: 240 }, keepNext: true } });

/**
 * 產生 Word 檔
 * @param {string} md 草稿（Markdown 或純文字）
 * @param {{ type?: "academic"|"project", cover?: object, autoNumber?: boolean, sortRefs?: boolean, fillMissing?: boolean }} opt
 */
export async function buildReport(md, opt = {}) {
  const type = opt.type === "project" ? "project" : "academic";
  const parsed = parseDraft(md, type);
  if (!parsed.some((b) => b.kind !== "heading")) throw userError("草稿沒有內文，請提供報告內容");
  const org = organize(parsed, { type, autoNumber: opt.autoNumber !== false, sortRefs: opt.sortRefs !== false, fillMissing: opt.fillMissing !== false });
  const { map } = org;
  const cover = opt.cover || {};
  const children = [];
  const H = (text, level = 1, extra = {}) =>
    new Paragraph({ heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4][level - 1], alignment: level === 1 ? AlignmentType.CENTER : AlignmentType.LEFT, children: [new TextRun({ text, font: FONT, bold: true, size: level === 1 ? 32 : 28 })], ...extra });
  // 前置：摘要、Abstract
  const frontSec = (name, blocks, en = false) => {
    children.push(H(name, 1, { pageBreakBefore: true }));
    if (!blocks?.length) children.push(placeholder(name === "摘要" ? "中文摘要（約 500 字）與關鍵詞" : "英文摘要與 Keywords"));
    for (const b of blocks || []) if (b.text) children.push(bodyPara(inlineRuns(b.text, null, { normalize: !en })));
  };
  frontSec("摘要", org.sections.摘要);
  frontSec("Abstract", org.sections.Abstract, true);
  // 目錄
  const tocTitle = (t) => new Paragraph({ style: "TocTitle", pageBreakBefore: true, alignment: AlignmentType.CENTER, children: [new TextRun({ text: t, font: FONT, size: 32, bold: true })] });
  children.push(tocTitle("目錄"), new TableOfContents("目錄", { hyperlink: true, headingStyleRange: "1-3" }));
  const hasFig = org.blocks.some((b) => b.kind === "image" && b.caption);
  const hasTab = org.blocks.some((b) => b.kind === "table" && b.caption);
  if (hasFig) children.push(tocTitle("圖目錄"), new TableOfContents("圖目錄", { hyperlink: true, captionLabelIncludingNumbers: "圖" }));
  if (hasTab) children.push(tocTitle("表目錄"), new TableOfContents("表目錄", { hyperlink: true, captionLabelIncludingNumbers: "表" }));
  // 本文
  let skipped = 0;
  for (const b of org.blocks) {
    if (b.kind === "heading") {
      if (b.level === 1 && b.backMatter && /^附錄/.test(b.text)) appendRefs();
      children.push(H(b.text, b.level, b.level === 1 ? { pageBreakBefore: true } : {}));
    } else if (b.kind === "para") children.push(bodyPara(inlineRuns(b.text, map)));
    else if (b.kind === "list") children.push(new Paragraph({ children: [new TextRun({ text: b.ordered ? b.marker.replace(/[、)]$/, ".") + " " : "• ", font: FONT, size: BODY }), ...inlineRuns(b.text, map)], alignment: AlignmentType.JUSTIFIED, spacing: { ...LINE }, indent: { left: 480 * (b.level + 1), hanging: 360 } }));
    else if (b.kind === "table") {
      if (b.caption) children.push(captionPara(b.caption));
      children.push(tableEl(b.rows, map), new Paragraph({ children: [], spacing: { after: 120 } }));
    } else if (b.kind === "image") {
      const el = await imageEl(b.src);
      if (!el) {
        skipped++;
        continue;
      }
      children.push(el);
      if (b.caption) children.push(captionPara(b.caption));
    } else if (b.kind === "caption") children.push(bodyPara(inlineRuns(`${b.label}${b.oldNo} ${b.title}`, map)));
  }
  let refsDone = false;
  function appendRefs() {
    if (refsDone) return;
    refsDone = true;
    children.push(H("參考文獻", 1, { pageBreakBefore: true }));
    if (!org.refs.length) children.push(placeholder("參考文獻（中文在前、英文在後；英文採 APA 格式）"));
    org.refs.forEach((r, k) =>
      children.push(new Paragraph({ alignment: AlignmentType.LEFT, spacing: { ...LINE, after: 60 }, indent: { left: 480, hanging: 480 }, children: [new TextRun({ text: `${k + 1}. `, font: FONT, size: BODY }), ...inlineRuns(r, null, { normalize: /^[\u4e00-\u9fff]/.test(r) })] })),
    );
  }
  // 參考文獻放在附錄之前（上面遇到附錄時已插入）；沒有附錄就放最後並加上附錄提示
  appendRefs();
  if (org.missing.includes("附錄")) children.push(H("附錄", 1, { pageBreakBefore: true }), placeholder("附錄（會議紀錄、公文、相似度報告等）"));
  // 封面
  const roc = new Date().getFullYear() - 1911;
  const now = new Date();
  const coverLines = [
    cover.category ? [cover.category, 32, false] : null,
    [cover.title || "報告標題", 40, true],
    cover.kind ? [cover.kind, 32, true] : null,
    null,
    cover.number ? [`計畫編號：${cover.number}`, 28, false] : null,
    cover.org ? [`執行機構：${cover.org}`, 28, false] : null,
    cover.pi ? [`計畫主持人：${cover.pi}`, 28, false] : null,
    cover.period ? [`執行期間：${cover.period}`, 28, false] : null,
    [cover.date || `中華民國 ${roc} 年 ${now.getMonth() + 1} 月`, 28, false],
  ];
  const coverChildren = [new Paragraph({ children: [], spacing: { before: 2400 } })];
  for (const l of coverLines) {
    if (!l) {
      coverChildren.push(new Paragraph({ children: [], spacing: { before: 1800 } }));
      continue;
    }
    coverChildren.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 }, children: [new TextRun({ text: l[0], font: FONT, size: l[1], bold: l[2] })] }));
  }
  const footer = new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 20 })] })] });
  const margin = { top: 1440, bottom: 1440, left: 1701, right: 1418 }; // 上下 2.54、左 3、右 2.5 公分
  const doc = new Document({
    creator: "AI 辦公服務平台",
    title: cover.title || "報告",
    features: { updateFields: true },
    styles: {
      default: {
        document: { run: { font: FONT, size: BODY }, paragraph: { alignment: AlignmentType.JUSTIFIED, spacing: LINE } },
        heading1: titleStyle(32),
        heading2: titleStyle(28),
        heading3: titleStyle(28),
        heading4: titleStyle(28),
      },
      paragraphStyles: [
        { id: "Caption", name: "caption", basedOn: "Normal", run: { font: FONT, size: 28 }, paragraph: { alignment: AlignmentType.CENTER } },
        { id: "TocTitle", name: "TOC Heading", basedOn: "Normal", run: { font: FONT, size: 32, bold: true }, paragraph: { alignment: AlignmentType.CENTER, spacing: { after: 240 } } },
      ],
    },
    sections: [
      { properties: { page: { margin } }, children: coverChildren },
      { properties: { page: { margin, pageNumbers: { start: 1 } } }, footers: { default: footer }, children },
    ],
  });
  const buf = await Packer.toBuffer(doc);
  if (skipped) org.log.push(`${skipped} 張圖片格式無法處理（例如 EMF），請在 Word 中手動插入`);
  return { buf, log: org.log, missing: org.missing, chapters: org.blocks.filter((b) => b.kind === "heading" && b.chapter).length, captions: [...org.map.values()].length };
}
