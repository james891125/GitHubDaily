// 論文 PDF 對照翻譯：保留原排版，把每個文字段落換成譯文；圖片、表格線、公式維持原樣。
// 參考 PDFMathTranslate 的做法：以 pdf.js 取得文字位置 → 組成段落 → 批次翻譯 → 在原位置蓋上譯文。
// 譯文以 sharp 轉成透明圖層嵌入（不需另外安裝中文字型）。
import { PDFDocument, rgb } from "pdf-lib";
import sharp from "sharp";
import { openPdf } from "./docs.js";
import { generate, generateJson } from "./llm.js";
import { parseRanges } from "./pdftools.js";

const userError = (m) => Object.assign(new Error(m), { status: 422 });
const CJK = /[⺀-鿿豈-﫿＀-￯]/;
const isCjk = (ch) => CJK.test(ch);

/** 由 pdf.js 的文字項目組成「行片段」：同一基線、水平相鄰的文字 */
function toSegments(items) {
  const segs = [];
  for (const it of items) {
    if (!("str" in it) || !it.str.trim()) continue;
    const [a, b, c, d, x, y] = it.transform;
    if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01) continue; // 旋轉的文字（例如邊欄浮水印）不處理
    const size = Math.abs(d) || Math.abs(a) || it.height || 10;
    const w = it.width || it.str.length * size * 0.5;
    const fits = (s) => Math.abs(s.y - y) < size * 0.35 && x - s.x1 < size * 1.2 && x - s.x1 > -size * 0.5 && Math.abs(s.size - size) < size * 0.3;
    let seg = segs.length && fits(segs.at(-1)) ? segs.at(-1) : null;
    if (!seg) seg = segs.slice(-12).find(fits);
    if (seg) {
      const gap = x - seg.x1;
      const last = seg.text.at(-1);
      if (gap > size * 0.12 && !seg.text.endsWith(" ") && !it.str.startsWith(" ") && !(isCjk(last) && isCjk(it.str[0]))) seg.text += " ";
      seg.text += it.str;
      seg.x1 = Math.max(seg.x1, x + w);
    } else segs.push({ text: it.str, x0: x, x1: x + w, y, size });
  }
  return segs.map((s) => ({ ...s, text: s.text.replace(/\s+/g, " ").trim() }));
}

/** 把行片段組成段落（支援雙欄：只合併上下相鄰且水平重疊的行） */
export function toBlocks(segs) {
  const sorted = [...segs].sort((p, q) => q.y - p.y || p.x0 - q.x0);
  const blocks = [];
  for (const s of sorted) {
    let best = null;
    let bestGap = Infinity;
    for (const b of blocks) {
      const last = b.lines.at(-1);
      const gap = last.y - s.y;
      if (gap < s.size * 0.6 || gap > Math.max(last.size, s.size) * 1.9) continue;
      if (Math.abs(last.size - s.size) > Math.max(last.size, s.size) * 0.15) continue;
      const overlap = Math.min(b.x1, s.x1) - Math.max(b.x0, s.x0);
      if (overlap < Math.min(b.x1 - b.x0, s.x1 - s.x0) * 0.3) continue;
      if (Math.abs(s.x0 - b.x0) > s.size * 3 && Math.abs(s.x0 - last.x0) > s.size * 3) continue;
      if (gap < bestGap) (best = b), (bestGap = gap);
    }
    if (best) {
      best.lines.push(s);
      best.x0 = Math.min(best.x0, s.x0);
      best.x1 = Math.max(best.x1, s.x1);
    } else blocks.push({ lines: [s], x0: s.x0, x1: s.x1 });
  }
  for (const b of blocks) {
    b.size = b.lines.reduce((a, l) => a + l.size, 0) / b.lines.length;
    b.top = b.lines[0].y + b.lines[0].size * 0.9;
    b.bottom = b.lines.at(-1).y - b.lines.at(-1).size * 0.28;
    // 行尾連字號接回單字；中英文之間不加空格
    b.text = b.lines.reduce((acc, l) => {
      if (!acc) return l.text;
      if (/[a-z]-$/.test(acc) && /^[a-z]/.test(l.text)) return acc.slice(0, -1) + l.text;
      return acc + (isCjk(acc.at(-1)) && isCjk(l.text[0]) ? "" : " ") + l.text;
    }, "");
  }
  // 依閱讀順序：先欄（左欄、右欄）再由上而下
  return blocks;
}

/** 判斷段落是否需要翻譯：排除公式、頁碼、純數字、已是中文的段落 */
export function shouldTranslate(text, target = "zh-TW") {
  const t = text.trim();
  const letters = (t.match(/\p{L}/gu) || []).length;
  if (letters < 3) return false;
  if (/^(\d+|[ivxlc]+|page \d+.*)$/i.test(t)) return false;
  // 公式：字母比例低、或多數是單一字母變數與符號
  const words = t.split(/\s+/);
  if (letters / t.replace(/\s/g, "").length < 0.5) return false;
  if (words.length >= 3 && words.filter((w) => /^\p{L}{2,}$/u.test(w.replace(/[.,;:()]/g, ""))).length / words.length < 0.3) return false;
  const cjk = (t.match(new RegExp(CJK.source, "g")) || []).length;
  if (/^zh/.test(target) && cjk / letters > 0.3) return false;
  return true;
}

const REF_HEAD = /^(\d+\.?\s*)?(references|bibliography|參考文獻|literature cited)$/i;

/** 讀取 PDF 版面：回傳每頁的大小與段落 */
export async function extractLayout(buf, { pages: spec = "", target = "zh-TW", skipReferences = true } = {}) {
  let doc;
  try {
    doc = await openPdf(buf);
  } catch (e) {
    throw userError(/password/i.test(e.message) ? "PDF 有密碼保護，請先解除密碼" : `無法讀取 PDF：${e.message}`);
  }
  const idx = parseRanges(spec, doc.numPages);
  if (idx.length > 100) throw userError(`一次最多處理 100 頁（此檔選取 ${idx.length} 頁），請用「頁碼範圍」分次處理`);
  const pages = [];
  let inRefs = false;
  for (const i of idx) {
    const page = await doc.getPage(i + 1);
    const [vx0, vy0, vx1, vy1] = page.view;
    const content = await page.getTextContent();
    const blocks = toBlocks(toSegments(content.items));
    // 閱讀順序：判斷雙欄（段落中心在左半或右半），先左欄再右欄
    const mid = (vx0 + vx1) / 2;
    const col = (b) => (b.x1 < mid + 5 ? 0 : b.x0 > mid - 5 ? 1 : -1);
    blocks.sort((p, q) => {
      const cp = col(p);
      const cq = col(q);
      if (cp !== cq && cp >= 0 && cq >= 0) return cp - cq;
      return q.top - p.top;
    });
    for (const b of blocks) {
      if (skipReferences && REF_HEAD.test(b.text.trim())) inRefs = true;
      b.translate = !inRefs && shouldTranslate(b.text, target);
    }
    pages.push({ index: i, view: [vx0, vy0, vx1, vy1], rotate: page.rotate || 0, blocks });
  }
  const textBlocks = pages.reduce((a, p) => a + p.blocks.length, 0);
  if (!textBlocks) throw userError("這份 PDF 沒有可擷取的文字（可能是掃描檔），請先使用「掃描文件文字辨識」服務");
  return { pages, total: doc.numPages };
}

const LANGS = { "zh-TW": "臺灣繁體中文", en: "English", ja: "日本語", ko: "한국어", "zh-CN": "简体中文" };

/** 批次翻譯段落（每批一次呼叫）；回傳數量不符時對半拆開重試 */
export async function translateBlocks(texts, { target = "zh-TW", glossary = "", signal, log = () => {}, maxChars = 6000 } = {}) {
  const lang = LANGS[target] || target;
  const out = new Array(texts.length);
  const batches = [];
  let cur = [];
  let size = 0;
  texts.forEach((t, i) => {
    if (cur.length && (size + t.length > maxChars || cur.length >= 40)) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(i);
    size += t.length;
  });
  if (cur.length) batches.push(cur);
  const schema = { type: "object", properties: { results: { type: "array", items: { type: "string" } } }, required: ["results"], additionalProperties: false };
  const rules = `翻譯要求：\n- 譯成${lang}，使用學術論文的正式書面語${target === "zh-TW" ? "與臺灣慣用譯名" : ""}\n- 保留數學符號、變數、公式、引用編號（如 [12]、(Smith, 2020)）、數字與單位\n- 專有名詞第一次出現時可在括號附原文\n- 只翻譯，不要加入說明${glossary ? `\n- 依照此術語表：\n${glossary}` : ""}`;
  let done = 0;
  const run = async (ids) => {
    if (signal?.aborted) throw new Error("已取消");
    if (ids.length === 1) {
      const { text } = await generate({ prompt: `${rules}\n\n只輸出譯文。\n\n---\n${texts[ids[0]]}`, light: true }, undefined, signal);
      out[ids[0]] = text.trim();
      return;
    }
    const items = ids.map((id, k) => `<item id="${k + 1}">\n${texts[id]}\n</item>`).join("\n\n");
    let res = null;
    try {
      const data = await generateJson(`以下有 ${ids.length} 個論文段落，請分別翻譯每一個 <item>，彼此不要合併或拆開。\n${rules}\n\n輸出 {"results":["第1段譯文","第2段譯文",...]}，共 ${ids.length} 個字串，順序與 id 相同。\n\n${items}`, { schema, light: true, signal });
      if (Array.isArray(data.results) && data.results.length === ids.length) res = data.results.map(String);
    } catch (e) {
      if (signal?.aborted) throw e;
    }
    if (res) ids.forEach((id, k) => (out[id] = res[k].trim()));
    else {
      log(`有 ${ids.length} 段的回傳數量不符，拆成兩批重試`);
      const h = Math.ceil(ids.length / 2);
      await run(ids.slice(0, h));
      await run(ids.slice(h));
    }
  };
  for (const ids of batches) {
    await run(ids);
    done += ids.length;
    log(`已翻譯 ${done}/${texts.length} 段`);
  }
  return out;
}

// ---------- 排版：把譯文放進原段落的方框 ----------
const FONT = "'Noto Sans CJK TC','Noto Sans TC','Microsoft JhengHei','PingFang TC','Heiti TC','WenQuanYi Zen Hei','Noto Sans CJK SC',sans-serif";
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);
const charW = (ch) => (isCjk(ch) ? 1 : ch === " " ? 0.28 : /[A-Z0-9mwMW@%]/.test(ch) ? 0.62 : 0.52);

/** 依寬度斷行（中文逐字、英文以單字為單位） */
export function wrapText(text, maxEm) {
  const tokens = String(text).match(/[A-Za-z0-9][\w'’.,;:%()\-\/]*\s*|\s+|./gsu) || [];
  const lines = [];
  let line = "";
  let w = 0;
  for (const tok of tokens) {
    const tw = [...tok].reduce((a, c) => a + charW(c), 0);
    if (w + tw > maxEm && line.trim()) {
      if (tw > maxEm) {
        // 超長單字：逐字切
        for (const ch of tok) {
          if (w + charW(ch) > maxEm && line) lines.push(line), (line = ""), (w = 0);
          line += ch;
          w += charW(ch);
        }
        continue;
      }
      lines.push(line.trimEnd());
      line = tok.trimStart();
      w = [...line].reduce((a, c) => a + charW(c), 0);
    } else {
      line += tok;
      w += tw;
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines;
}

/** 找出能放進方框的字級與斷行 */
export function fitText(text, width, height, maxSize) {
  let size = Math.min(maxSize, 16);
  for (; size >= 4; size -= 0.5) {
    const lines = wrapText(text, width / size);
    if (lines.length * size * 1.25 <= height * 1.08 + size * 0.3) return { size, lines };
  }
  return { size: 4, lines: wrapText(text, width / 4) };
}

async function overlayPng(page, scale) {
  const [vx0, , vx1, vy1] = page.view;
  const W = vx1 - vx0;
  const H = page.view[3] - page.view[1];
  const parts = [];
  for (const b of page.blocks) {
    if (!b.out) continue;
    const width = b.x1 - b.x0;
    const height = Math.max(b.top - b.bottom, b.size * 1.2);
    const { size, lines } = fitText(b.out, width, height, b.size);
    const x = (b.x0 - vx0) * scale;
    const y0 = (vy1 - b.top) * scale;
    parts.push(
      `<text font-family="${FONT}" font-size="${(size * scale).toFixed(2)}" fill="#111">${lines
        .map((l, i) => `<tspan x="${x.toFixed(1)}" y="${(y0 + (size * 0.95 + i * size * 1.25) * scale).toFixed(1)}">${esc(l)}</tspan>`)
        .join("")}</text>`,
    );
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(W * scale)}" height="${Math.round(H * scale)}">${parts.join("")}</svg>`;
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9, palette: true }).toBuffer();
}

/**
 * 產生對照 PDF
 * layout：side（左原文、右譯文）／only（只有譯文）／interleave（原文頁後接譯文頁）
 */
export async function buildTranslatedPdf(buf, layout, { layout: lay = "side", scale = 2.5 } = {}) {
  const src = await PDFDocument.load(buf, { updateMetadata: false });
  const out = await PDFDocument.create();
  for (const pg of layout.pages) {
    const [vx0, vy0, vx1, vy1] = pg.view;
    const W = vx1 - vx0;
    const H = vy1 - vy0;
    const png = await out.embedPng(await overlayPng(pg, scale));
    const cover = (page, dx) => {
      for (const b of pg.blocks) {
        if (!b.out) continue;
        const pad = Math.min(2, b.size * 0.15);
        page.drawRectangle({ x: b.x0 - vx0 + dx - pad, y: b.bottom - vy0 - pad, width: b.x1 - b.x0 + pad * 2, height: b.top - b.bottom + pad * 2, color: rgb(1, 1, 1) });
      }
      page.drawImage(png, { x: dx, y: 0, width: W, height: H });
    };
    const [orig] = await out.embedPages([src.getPage(pg.index)], [{ left: vx0, bottom: vy0, right: vx1, top: vy1 }]);
    if (lay === "side") {
      const page = out.addPage([W * 2, H]);
      page.drawPage(orig, { x: 0, y: 0 });
      page.drawPage(orig, { x: W, y: 0 });
      cover(page, W);
      page.drawLine({ start: { x: W, y: 0 }, end: { x: W, y: H }, thickness: 0.5, color: rgb(0.75, 0.75, 0.75) });
    } else {
      if (lay === "interleave") out.addPage([W, H]).drawPage(orig, { x: 0, y: 0 });
      const page = out.addPage([W, H]);
      page.drawPage(orig, { x: 0, y: 0 });
      cover(page, 0);
    }
  }
  return Buffer.from(await out.save({ useObjectStreams: true }));
}

/** 原文／譯文對照表（Markdown，可轉成 Word） */
export function bilingualMarkdown(layout, title) {
  const L = [`# ${title}`, "", "| 頁 | 原文 | 譯文 |", "|---|---|---|"];
  const cell = (s) => String(s).replace(/\|/g, "／").replace(/\n+/g, " ");
  for (const p of layout.pages) for (const b of p.blocks) if (b.out) L.push(`| ${p.index + 1} | ${cell(b.text)} | ${cell(b.out)} |`);
  return L.join("\n");
}

/** 一次完成：版面分析 → 翻譯 → 產生 PDF */
export async function translatePdf(buf, { target = "zh-TW", pages = "", layout = "side", glossary = "", skipReferences = true, signal, log = () => {} } = {}) {
  const lay = await extractLayout(buf, { pages, target, skipReferences });
  const todo = lay.pages.flatMap((p) => p.blocks.filter((b) => b.translate));
  const kept = lay.pages.reduce((a, p) => a + p.blocks.length, 0) - todo.length;
  log(`${lay.pages.length} 頁、${todo.length} 個段落需要翻譯（${kept} 個公式、頁碼、參考文獻等保留原文）`);
  if (!todo.length) throw userError("沒有找到需要翻譯的段落（可能已經是目標語言，或全為公式、圖片）");
  const outs = await translateBlocks(
    todo.map((b) => b.text),
    { target, glossary, signal, log },
  );
  todo.forEach((b, i) => (b.out = outs[i]));
  log("排版中…");
  const pdf = await buildTranslatedPdf(buf, lay, { layout });
  return { pdf, layout: lay, blocks: todo.length };
}
