// 簡報產生：文件 → AI 規劃投影片（或直接用大綱，不用 AI）→ PowerPoint（.pptx）
// 參考 PptxGenJS、Paper2Slides 的做法：圖表為 PowerPoint 原生圖表（可再編輯），流程圖等以本平台的圖表功能繪製；每頁附講稿（備忘稿）。
import PptxGenJS from "pptxgenjs";
import { renderDiagram, svgToPng, DIAGRAM_TYPES } from "./diagram.js";
import sharp from "sharp";

const userError = (m) => Object.assign(new Error(m), { status: 422 });
const FONT = "Microsoft JhengHei";
// 類別色（依序使用，已通過色盲辨識檢查）；單一數列只用第一色
const SERIES = ["2A6299", "D17A22", "8A5CB0", "3F8F5A"];
export const THEMES = {
  official: { name: "公務藍（深藍標題列）", bar: "1F3A5F", accent: "2A6299", title: "FFFFFF", text: "222A33", muted: "5F6B78", bg: "FFFFFF" },
  simple: { name: "簡約白（細線條）", bar: null, accent: "2A6299", title: "1F3A5F", text: "222A33", muted: "5F6B78", bg: "FFFFFF" },
};

// ---------------- 大綱 → 投影片結構（不用 AI） ----------------
/**
 * # 簡報標題（下一行為副標題）
 * ## 每張投影片標題
 * - 重點（縮排兩格為子項目）
 * | 表格 |
 * ```flow / ```org / ```mind / ```gantt 圖表寫法 ```
 * ![說明](data:image/png;base64,...)
 * 備註：講稿內容
 */
export function parseOutline(md) {
  const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
  const deck = { title: "", subtitle: "", slides: [] };
  let cur = null;
  const push = (s) => (deck.slides.push(s), (cur = s));
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;
    let m;
    if ((m = /^#\s+(.+)$/.exec(line))) {
      if (!deck.title) {
        deck.title = m[1].trim();
        const next = lines[i + 1]?.trim();
        if (next && !/^[#\-*|!`]/.test(next)) (deck.subtitle = next), i++;
      } else push({ type: "section", title: m[1].trim() });
      continue;
    }
    if ((m = /^#{2,3}\s+(.+)$/.exec(line))) {
      push({ type: "bullets", title: m[1].trim(), bullets: [] });
      continue;
    }
    if (!cur) push({ type: "bullets", title: deck.title || "內容", bullets: [] });
    if ((m = /^```\s*(flow|org|mind|gantt)\s*$/.exec(line))) {
      const body = [];
      for (i++; i < lines.length && !/^```/.test(lines[i].trim()); i++) body.push(lines[i]);
      Object.assign(cur, { type: "diagram", diagram: { kind: m[1], text: body.join("\n") } });
      continue;
    }
    if (/^\|.*\|$/.test(line) && /^\|?\s*:?-{2,}/.test(lines[i + 1]?.trim() || "")) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const columns = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(cells(lines[i]));
      i--;
      Object.assign(cur, { type: "table", columns, rows });
      continue;
    }
    if ((m = /^!\[([^\]]*)\]\((data:image\/[^)]+)\)$/.exec(line))) {
      Object.assign(cur, { type: "image", image: m[2], caption: m[1] });
      continue;
    }
    if ((m = /^(?:備註|講稿|notes?)\s*[:：]\s*(.*)$/i.exec(line))) {
      cur.notes = (cur.notes ? cur.notes + "\n" : "") + m[1];
      continue;
    }
    const li = /^(\s*)(?:[-*•]|\d+[.、)])\s+(.*)$/.exec(raw);
    const text = (li ? li[2] : line).replace(/\*\*/g, "");
    (cur.bullets ||= []).push({ text, level: li ? Math.min(Math.floor(li[1].length / 2), 2) : 0 });
  }
  if (!deck.slides.length) throw userError("大綱中沒有投影片。請用「## 投影片標題」分頁，「- 重點」列出內容");
  return deck;
}

// ---------------- AI 規劃 ----------------
export const DECK_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    subtitle: { type: "string" },
    slides: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["bullets", "twocol", "table", "chart", "diagram", "section"] },
          title: { type: "string" },
          bullets: { type: "array", items: { type: "string" } },
          left: { type: "array", items: { type: "string" } },
          right: { type: "array", items: { type: "string" } },
          leftTitle: { type: "string" },
          rightTitle: { type: "string" },
          columns: { type: "array", items: { type: "string" } },
          rows: { type: "array", items: { type: "array", items: { type: "string" } } },
          chart: {
            type: "object",
            properties: { kind: { type: "string", enum: ["bar", "line"] }, labels: { type: "array", items: { type: "string" } }, series: { type: "array", items: { type: "object", properties: { name: { type: "string" }, values: { type: "array", items: { type: "number" } } }, required: ["name", "values"], additionalProperties: false } }, unit: { type: "string" } },
            required: ["kind", "labels", "series"],
            additionalProperties: false,
          },
          diagram: { type: "object", properties: { kind: { type: "string", enum: ["flow", "org", "mind", "gantt"] }, text: { type: "string" } }, required: ["kind", "text"], additionalProperties: false },
          notes: { type: "string" },
        },
        required: ["type", "title"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "slides"],
  additionalProperties: false,
};

export function deckPrompt(doc, { count = 10, audience = "", minutes = "" } = {}) {
  return `請依下列文件規劃一份簡報投影片（約 ${count} 張，不含封面），使用臺灣繁體中文${audience ? `，對象：${audience}` : ""}${minutes ? `，報告時間約 ${minutes} 分鐘` : ""}。
輸出 JSON：{"title":"簡報標題","subtitle":"副標題","slides":[...]}，每張投影片的 type 擇一：
- "bullets"：bullets 3–6 點，每點 30 字內，用名詞片語或短句，不要整段文字
- "twocol"：左右對照（leftTitle、left、rightTitle、right），適合比較、優缺點、前後差異
- "table"：columns 與 rows（最多 6 欄 8 列），用於文件中的數據表
- "chart"：chart = {"kind":"bar"或"line","labels":[...],"series":[{"name":"...","values":[數字...]}],"unit":"單位"}；只能使用文件中出現的數字，最多 4 個數列；趨勢用 line、比較用 bar
- "diagram"：diagram = {"kind":"flow"|"org"|"mind"|"gantt","text":"圖表寫法"}；流程用 flow（每行「步驟A -> 步驟B」，條件寫「審核？ -[通過]-> 核發」）、組織架構用 org（縮排大綱）、時程用 gantt（每行「工作, 開始日期, 結束日期或天數」）
- "section"：章節分隔頁（只要 title）
每張都要有 notes：講者口說的講稿（2–4 句，口語但正式）。
不要編造文件中沒有的數字或事實；第一張不要放封面（封面會自動產生）；最後一張放「結論與建議」或重點回顧。

文件：
${doc}`;
}

/** 檢查 AI 回傳的結構，修正常見問題（缺少欄位、數列長度不符） */
export function sanitizeDeck(deck) {
  const out = { title: String(deck?.title || "簡報").slice(0, 80), subtitle: String(deck?.subtitle || "").slice(0, 120), slides: [] };
  for (const s of deck?.slides || []) {
    if (!s || !s.title) continue;
    const t = { ...s, title: String(s.title).slice(0, 60) };
    if (t.type === "chart") {
      const c = t.chart;
      const ok = c && Array.isArray(c.labels) && c.labels.length && Array.isArray(c.series) && c.series.length && c.series.every((x) => Array.isArray(x.values) && x.values.length === c.labels.length && x.values.every((v) => Number.isFinite(Number(v))));
      if (!ok) Object.assign(t, { type: "bullets", bullets: t.bullets?.length ? t.bullets : ["（圖表資料不完整，已略過）"] });
      else t.chart = { ...c, series: c.series.slice(0, 4).map((x) => ({ name: String(x.name), values: x.values.map(Number) })) };
    }
    if (t.type === "table" && !(Array.isArray(t.columns) && t.columns.length && Array.isArray(t.rows))) Object.assign(t, { type: "bullets", bullets: t.bullets || [] });
    if (t.type === "diagram" && !(t.diagram?.text && DIAGRAM_TYPES[t.diagram.kind])) Object.assign(t, { type: "bullets", bullets: t.bullets || [] });
    if (t.type === "bullets") t.bullets = (t.bullets || []).map((b) => (typeof b === "string" ? { text: b, level: 0 } : b)).slice(0, 8);
    out.slides.push(t);
  }
  if (!out.slides.length) throw userError("AI 沒有產生任何投影片，請再試一次或換一個模型");
  return out;
}

// ---------------- 產生 PowerPoint ----------------
const W = 13.333;
const H = 7.5;

async function diagramImage(kind, text) {
  const svg = renderDiagram(kind, text, {});
  const png = await svgToPng(svg, 192);
  const m = await sharp(png).metadata();
  return { data: "data:image/png;base64," + png.toString("base64"), w: m.width, h: m.height };
}
async function dataImage(uri) {
  const b64 = uri.split(",")[1] || "";
  const m = await sharp(Buffer.from(b64, "base64")).metadata();
  return { data: uri, w: m.width, h: m.height };
}
const fit = (img, box) => {
  const s = Math.min(box.w / img.w, box.h / img.h);
  const w = img.w * s;
  const h = img.h * s;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
};

/**
 * @param {{ title, subtitle, slides }} deck
 * @param {{ theme?: string, presenter?: string, org?: string, date?: string, closing?: boolean }} opt
 */
export async function buildPptx(deck, opt = {}) {
  const th = THEMES[opt.theme] || THEMES.official;
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = deck.title;
  pptx.company = opt.org || "";
  const footer = [opt.org, opt.presenter].filter(Boolean).join("｜");
  pptx.defineSlideMaster({
    title: "CONTENT",
    background: { color: th.bg },
    objects: [
      ...(th.bar ? [{ rect: { x: 0, y: 0, w: W, h: 1.0, fill: { color: th.bar } } }] : [{ line: { x: 0.6, y: 1.05, w: W - 1.2, h: 0, line: { color: th.accent, width: 2 } } }]),
      ...(footer ? [{ text: { text: footer, options: { x: 0.6, y: H - 0.45, w: 8, h: 0.3, fontFace: FONT, fontSize: 10, color: th.muted } } }] : []),
    ],
    slideNumber: { x: W - 1.2, y: H - 0.45, w: 0.7, h: 0.3, fontFace: FONT, fontSize: 10, color: th.muted, align: "right" },
  });
  const titleOpts = { x: 0.6, y: 0.12, w: W - 1.2, h: 0.8, fontFace: FONT, fontSize: 26, bold: true, color: th.title, valign: "middle", fit: "shrink" };
  const body = { x: 0.8, y: 1.35, w: W - 1.6, h: H - 2.1 };

  // 封面
  const cover = pptx.addSlide();
  cover.background = { color: th.bar || "FFFFFF" };
  const ink = th.bar ? "FFFFFF" : th.title;
  cover.addText(deck.title, { x: 0.8, y: 2.0, w: W - 1.6, h: 1.5, fontFace: FONT, fontSize: 40, bold: true, color: ink, align: "center", valign: "middle", fit: "shrink" });
  if (deck.subtitle) cover.addText(deck.subtitle, { x: 0.8, y: 3.5, w: W - 1.6, h: 0.8, fontFace: FONT, fontSize: 22, color: ink, align: "center" });
  cover.addShape(pptx.ShapeType.line, { x: W / 2 - 1.5, y: 4.5, w: 3, h: 0, line: { color: th.bar ? "8FB2D6" : th.accent, width: 1.5 } });
  const meta = [opt.presenter, opt.org, opt.date].filter(Boolean).join("\n");
  if (meta) cover.addText(meta, { x: 0.8, y: 4.7, w: W - 1.6, h: 1.4, fontFace: FONT, fontSize: 18, color: ink, align: "center", valign: "top" });

  for (const s of deck.slides) {
    if (s.type === "section") {
      const sl = pptx.addSlide();
      sl.background = { color: th.bar || "EEF3F9" };
      sl.addText(s.title, { x: 0.8, y: 2.6, w: W - 1.6, h: 1.4, fontFace: FONT, fontSize: 34, bold: true, color: th.bar ? "FFFFFF" : th.title, align: "center", valign: "middle" });
      if (s.notes) sl.addNotes(s.notes);
      continue;
    }
    const sl = pptx.addSlide({ masterName: "CONTENT" });
    sl.addText(s.title, titleOpts);
    if (s.type === "bullets" || s.type === "twocol") {
      const bullets = (list, size) =>
        (list || []).map((b) => {
          const it = typeof b === "string" ? { text: b, level: 0 } : b;
          return { text: it.text, options: { bullet: it.level ? { indent: 18 } : { code: "25A0", indent: 22 }, indentLevel: it.level || 0, fontSize: it.level ? size - 4 : size, color: it.level ? th.muted : th.text, breakLine: true, paraSpaceAfter: 8 } };
        });
      if (s.type === "bullets") sl.addText(bullets(s.bullets, 24), { ...body, fontFace: FONT, valign: "top", fit: "shrink" });
      else {
        const colW = (body.w - 0.4) / 2;
        for (const [k, side] of [[0, "left"], [1, "right"]]) {
          const x = body.x + k * (colW + 0.4);
          sl.addText(s[side + "Title"] || "", { x, y: body.y, w: colW, h: 0.55, fontFace: FONT, fontSize: 20, bold: true, color: th.accent });
          sl.addShape(pptx.ShapeType.line, { x, y: body.y + 0.58, w: colW, h: 0, line: { color: "C5D0DC", width: 1 } });
          sl.addText(bullets(s[side], 20), { x, y: body.y + 0.7, w: colW, h: body.h - 0.8, fontFace: FONT, valign: "top", fit: "shrink" });
        }
      }
    } else if (s.type === "table") {
      const cols = s.columns.slice(0, 6);
      const rows = s.rows.slice(0, 10).map((r) => cols.map((_, i) => String(r[i] ?? "")));
      const size = rows.length > 7 || cols.length > 4 ? 13 : 15;
      sl.addTable(
        [cols.map((c) => ({ text: c, options: { bold: true, color: "FFFFFF", fill: { color: th.accent } } })), ...rows.map((r, ri) => r.map((c) => ({ text: c, options: { fill: { color: ri % 2 ? "F3F5F8" : "FFFFFF" } } })))],
        { x: body.x, y: body.y, w: body.w, fontFace: FONT, fontSize: size, color: th.text, border: { type: "solid", pt: 0.75, color: "C5D0DC" }, valign: "middle", autoPage: false },
      );
      if (s.rows.length > 10) sl.addText(`（共 ${s.rows.length} 列，僅列出前 10 列）`, { x: body.x, y: H - 0.9, w: 6, h: 0.3, fontFace: FONT, fontSize: 11, color: th.muted });
    } else if (s.type === "chart") {
      const c = s.chart;
      const multi = c.series.length > 1;
      sl.addChart(c.kind === "line" ? pptx.ChartType.line : pptx.ChartType.bar, c.series.map((x) => ({ name: x.name, labels: c.labels.map(String), values: x.values })), {
        ...body,
        barDir: "col",
        barGapWidthPct: 60,
        chartColors: SERIES.slice(0, c.series.length),
        lineSize: 2,
        lineDataSymbolSize: 8,
        showLegend: multi,
        legendPos: "t",
        legendFontFace: FONT,
        legendFontSize: 14,
        showValue: !multi && c.labels.length <= 12,
        dataLabelFontFace: FONT,
        dataLabelFontSize: 12,
        dataLabelColor: th.text,
        catAxisLabelFontFace: FONT,
        catAxisLabelFontSize: 14,
        catAxisLabelColor: th.text,
        valAxisLabelFontFace: FONT,
        valAxisLabelFontSize: 12,
        valAxisLabelColor: th.muted,
        valGridLine: { color: "E3E7EC", size: 0.75 },
        catGridLine: { style: "none" },
        valAxisTitle: c.unit || "",
        showValAxisTitle: !!c.unit,
        valAxisTitleFontFace: FONT,
        valAxisTitleFontSize: 12,
        valAxisTitleColor: th.muted,
      });
    } else if (s.type === "diagram" || s.type === "image") {
      let img;
      try {
        img = s.type === "diagram" ? await diagramImage(s.diagram.kind, s.diagram.text) : await dataImage(s.image);
      } catch (e) {
        sl.addText(`（圖表無法產生：${e.message}）`, { ...body, fontFace: FONT, fontSize: 16, color: th.muted });
        img = null;
      }
      if (img) {
        const box = s.caption ? { ...body, h: body.h - 0.5 } : body;
        sl.addImage({ data: img.data, ...fit(img, box) });
        if (s.caption) sl.addText(s.caption, { x: body.x, y: body.y + body.h - 0.45, w: body.w, h: 0.4, fontFace: FONT, fontSize: 14, color: th.muted, align: "center" });
      }
    }
    if (s.notes) sl.addNotes(s.notes);
  }
  if (opt.closing !== false) {
    const end = pptx.addSlide();
    end.background = { color: th.bar || "FFFFFF" };
    end.addText("敬請指教", { x: 0.8, y: 2.8, w: W - 1.6, h: 1.4, fontFace: FONT, fontSize: 40, bold: true, color: th.bar ? "FFFFFF" : th.title, align: "center", valign: "middle" });
  }
  return Buffer.from(await pptx.write({ outputType: "nodebuffer" }));
}

/** 簡報內容的文字版（講稿），方便複製或另存 Word */
export function deckToMarkdown(deck) {
  const L = [`# ${deck.title}`, deck.subtitle ? `\n${deck.subtitle}` : "", ""];
  deck.slides.forEach((s, i) => {
    L.push(`## ${i + 1}. ${s.title}`, "");
    for (const b of s.bullets || []) L.push(`${"  ".repeat(b.level || 0)}- ${b.text ?? b}`);
    if (s.type === "twocol") L.push(`**${s.leftTitle || "左"}**：${(s.left || []).join("；")}`, "", `**${s.rightTitle || "右"}**：${(s.right || []).join("；")}`);
    if (s.type === "table") L.push(`（表格：${s.columns.join("、")}，${s.rows.length} 列）`);
    if (s.type === "chart") L.push(`（圖表：${s.chart.series.map((x) => x.name).join("、")}）`);
    if (s.type === "diagram") L.push(`（${DIAGRAM_TYPES[s.diagram.kind]}）`);
    if (s.notes) L.push("", `> 講稿：${s.notes}`);
    L.push("");
  });
  return L.join("\n");
}
