// AI 工作流引擎：依序執行節點，節點之間以變數傳遞資料。
// 模板語法：{{變數}}、{{變數.欄位}}、{{input}}、{{today}}、{{now}}
import fs from "node:fs";
import path from "node:path";
import { load, save, newId, writeOutput, DATA_DIR } from "./store.js";
import { generate, generateJson, withUsage, currentUsage } from "./llm.js";
import { scrapePage, crawlSite, checkSite, reportToMarkdown } from "./web.js";
import { translate, summarize, extractTable, toCsv, toXlsx, toMarkdownTable, compactText, chunkLimits } from "./doctools.js";
import { parseDocument } from "./docs.js";
import * as kb from "./kb.js";
import { markdownToDocx } from "./docx.js";
import { transcribe, toSrt, toVtt, toTimestamped, generateImages, AUDIO_TYPES } from "./media.js";
import { analyzeSurvey, surveyMarkdown, statsForAI, openAnswersForAI, surveyXlsx, surveyHtml, chartFor, svgToPng } from "./survey.js";
import { checkDocx, fixDocx, resultsToMarkdown } from "./formatcheck.js";
import * as pdf from "./pdftools.js";
import { batchImages, IMAGE_FORMATS, IMAGE_INPUT } from "./imagetools.js";
import { convertWithOffice } from "./formats.js";
import { miniMarkdown } from "../public/mini-md.js";
import JSZip from "jszip";
import sharp from "sharp";
import { searchPapers, papersToTable, readFeed, formatCitations, CITE_STYLES, convertChinese, ZH_MODES, compareTexts, parseTable, tableStats } from "./tools.js";

export const PDF_OPS = { merge: "合併多個 PDF", split: "分割成多個檔", extract: "擷取／重新排序頁面", delete: "刪除頁面", rotate: "旋轉頁面", watermark: "加文字浮水印", pagenum: "加頁碼", compress: "壓縮檔案大小", images: "圖片轉 PDF" };

// ---------- 節點定義（前端依此產生表單） ----------
export const NODE_TYPES = {
  fetch_url: {
    label: "擷取網頁",
    desc: "抓取網址內容並轉成 Markdown",
    fields: { url: { label: "網址（可用變數）", type: "text", default: "{{input}}" }, mode: { label: "模式", type: "select", options: { article: "只取正文", full: "整頁" }, default: "article" } },
    out: "page",
  },
  crawl: {
    label: "爬取網站",
    desc: "從起始網址爬取同網域多個頁面",
    fields: {
      url: { label: "起始網址", type: "text", default: "{{input}}" },
      maxPages: { label: "最多頁數", type: "number", default: 10 },
      maxDepth: { label: "最大深度", type: "number", default: 2 },
      include: { label: "只爬符合（正則，選填）", type: "text", default: "" },
    },
    out: "site",
  },
  http: {
    label: "呼叫 API",
    desc: "發送 HTTP 請求到任何 API，回傳 JSON 或文字",
    fields: {
      method: { label: "方法", type: "select", options: { GET: "GET", POST: "POST", PUT: "PUT" }, default: "GET" },
      url: { label: "網址", type: "text", default: "" },
      headers: { label: "標頭（每行 Key: Value）", type: "textarea", default: "" },
      body: { label: "內容（POST/PUT）", type: "textarea", default: "" },
    },
    out: "api",
  },
  read_file: {
    label: "讀取檔案",
    desc: "讀取檔案庫中的 PDF / Word / Excel / 文字檔",
    fields: { fileId: { label: "檔案", type: "file", default: "" } },
    out: "doc",
  },
  kb_search: {
    label: "知識庫檢索",
    desc: "從知識庫找出與問題最相關的段落",
    fields: { kbId: { label: "知識庫", type: "kb", default: "" }, query: { label: "查詢", type: "text", default: "{{input}}" }, k: { label: "段落數", type: "number", default: 4 } },
    out: "context",
  },
  kb_add: {
    label: "存入知識庫",
    desc: "把文字或爬取結果加入知識庫",
    fields: { kbId: { label: "知識庫", type: "kb", default: "" }, source: { label: "內容來源變數", type: "text", default: "{{site}}" }, title: { label: "標題", type: "text", default: "{{input}}" } },
    out: "kbResult",
  },
  llm: {
    label: "AI 處理",
    desc: "用自訂提示讓 AI 處理資料",
    fields: { prompt: { label: "提示", type: "textarea", default: "請整理以下內容的重點：\n\n{{page}}" }, system: { label: "角色設定（選填）", type: "textarea", default: "" } },
    out: "ai",
  },
  llm_each: {
    label: "逐項 AI 處理",
    desc: "對清單中的每一項分別執行提示（例如每個網址、每一頁、每一行）",
    fields: {
      list: { label: "清單來源（變數或每行一項）", type: "text", default: "{{input}}" },
      prompt: { label: "每項的提示（用 {{item}}）", type: "textarea", default: "請用三句話摘要：\n{{item}}" },
      fetch: { label: "每項若是網址，先擷取網頁內容", type: "checkbox", default: false },
    },
    out: "items",
  },
  translate: {
    label: "翻譯",
    desc: "分段翻譯長文並保留格式",
    fields: {
      source: { label: "內容", type: "text", default: "{{page}}" },
      target: { label: "目標語言", type: "select", options: { "zh-TW": "繁體中文", "zh-CN": "简体中文", en: "English", ja: "日本語", ko: "한국어" }, default: "zh-TW" },
    },
    out: "translated",
  },
  summarize: {
    label: "摘要",
    desc: "長文自動分段摘要",
    fields: { source: { label: "內容", type: "text", default: "{{page}}" }, style: { label: "風格", type: "text", default: "重點條列" } },
    out: "summary",
  },
  extract: {
    label: "擷取成表格",
    desc: "從文字擷取指定欄位成表格資料",
    fields: { source: { label: "內容", type: "text", default: "{{doc}}" }, fields: { label: "欄位（逗號分隔）", type: "text", default: "名稱, 價格, 說明" }, instruction: { label: "擷取條件（選填）", type: "text", default: "" } },
    out: "table",
  },
  site_check: {
    label: "網站檢測",
    desc: "檢查 SSL、DNS、安全標頭、SEO、失效連結並評分",
    fields: { url: { label: "網址", type: "text", default: "{{input}}" } },
    out: "check",
  },
  condition: {
    label: "條件判斷",
    desc: "條件不成立時，停止執行後續節點",
    fields: {
      left: { label: "值", type: "text", default: "{{check.score}}" },
      op: { label: "比較", type: "select", options: { lt: "小於", gt: "大於", eq: "等於", ne: "不等於", contains: "包含", not_contains: "不包含", changed: "與上次執行不同" }, default: "lt" },
      right: { label: "比較值", type: "text", default: "80" },
    },
    out: "",
  },
  set: {
    label: "組合文字",
    desc: "用模板組出新的變數內容",
    fields: { value: { label: "內容", type: "textarea", default: "# 報告 {{today}}\n\n{{ai}}" } },
    out: "text",
  },
  save_file: {
    label: "輸出檔案",
    desc: "存成 Markdown / 文字 / CSV / Excel / JSON",
    fields: {
      source: { label: "內容", type: "text", default: "{{ai}}" },
      format: { label: "格式", type: "select", options: { docx: "Word (.docx)", md: "Markdown (.md)", txt: "文字 (.txt)", csv: "CSV", xlsx: "Excel (.xlsx)", json: "JSON", srt: "字幕 (.srt)", vtt: "字幕 (.vtt)" }, default: "md" },
      formal: { label: "Word 使用標楷體（公文等正式文件）", type: "checkbox", default: false },
      filename: { label: "檔名", type: "text", default: "報告-{{today}}" },
    },
    out: "file",
  },
  ocr: {
    label: "文字辨識（掃描檔／圖片）",
    desc: "由 AI 直接閱讀掃描型 PDF 或照片，轉成文字（PDF 需使用 Claude）",
    fields: { fileId: { label: "檔案", type: "file", default: "" }, instruction: { label: "額外要求（選填）", type: "text", default: "" } },
    out: "doc",
  },
  paper_search: {
    label: "文獻搜尋",
    desc: "從 OpenAlex 或 arXiv 搜尋論文（免金鑰、不使用 AI）",
    fields: {
      query: { label: "關鍵字", type: "text", default: "{{input}}" },
      source: { label: "資料庫", type: "select", options: { openalex: "OpenAlex（跨領域、含期刊）", arxiv: "arXiv（預印本）" }, default: "openalex" },
      limit: { label: "篇數", type: "number", default: 10 },
      fromYear: { label: "起始年份（選填）", type: "number", default: "" },
      sort: { label: "排序", type: "select", options: { relevance: "相關度", date: "最新", cited: "被引用次數（僅 OpenAlex）" }, default: "relevance" },
    },
    out: "papers",
  },
  rss: {
    label: "讀取 RSS 訂閱",
    desc: "讀取新聞、部落格、公告的 RSS / Atom 訂閱（不使用 AI）",
    fields: { url: { label: "訂閱網址（每行一個）", type: "textarea", default: "{{input}}" }, limit: { label: "每個來源最多幾則", type: "number", default: 10 }, sinceDays: { label: "只取最近幾天（選填）", type: "number", default: "" } },
    out: "feed",
  },
  cite: {
    label: "參考文獻格式",
    desc: "以 DOI 查詢並產生 APA、IEEE 等格式（不使用 AI）",
    fields: { source: { label: "DOI 清單", type: "textarea", default: "{{input}}" }, style: { label: "格式", type: "select", options: CITE_STYLES, default: "apa" } },
    out: "citations",
  },
  convert_zh: {
    label: "繁簡轉換",
    desc: "簡體與繁體互轉，含台灣用詞（不使用 AI）",
    fields: { source: { label: "內容", type: "text", default: "{{input}}" }, mode: { label: "轉換方式", type: "select", options: ZH_MODES, default: "s2twp" } },
    out: "converted",
  },
  compare: {
    label: "文件比對",
    desc: "比較兩份文件的差異（不使用 AI）",
    fields: { a: { label: "舊版內容", type: "text", default: "{{docA}}" }, b: { label: "新版內容", type: "text", default: "{{docB}}" } },
    out: "diff",
  },
  table_stats: {
    label: "資料表統計",
    desc: "讀取 CSV / Excel 並計算平均、最大最小、類別次數（不使用 AI）",
    fields: { fileId: { label: "資料檔", type: "file", default: "" } },
    out: "stats",
  },
  web_research: {
    label: "網路搜尋研究",
    desc: "由 AI 上網搜尋最新資料並整理成附來源的報告（需要 Claude）",
    fields: { prompt: { label: "研究問題", type: "textarea", default: "{{input}}" }, maxSearches: { label: "最多搜尋次數", type: "number", default: 5 } },
    out: "research",
  },
  transcribe: {
    label: "語音轉文字",
    desc: "將錄音檔轉成逐字稿（使用系統設定中的語音轉文字服務：OpenAI、Groq、Gemini 或 OpenRouter）",
    fields: {
      fileId: { label: "音檔", type: "file", default: "" },
      language: { label: "語言", type: "select", options: { "zh-TW": "繁體中文", en: "English", ja: "日本語", ko: "한국어", auto: "自動偵測" }, default: "zh-TW" },
      prompt: { label: "專有名詞提示（選填）", type: "text", default: "" },
    },
    out: "transcript",
  },
  image_ask: {
    label: "圖片分析",
    desc: "讓 AI 看圖片並回答問題（例如解讀圖表、說明示意圖、產生替代文字）",
    fields: { fileId: { label: "圖片", type: "file", default: "" }, question: { label: "問題", type: "textarea", default: "請詳細說明這張圖片的內容。" } },
    out: "ai",
  },
  image_gen: {
    label: "圖片生成",
    desc: "由 AI 依描述產生圖片（使用系統設定中的圖片生成服務）",
    fields: {
      prompt: { label: "圖片描述", type: "textarea", default: "{{input}}" },
      size: { label: "尺寸", type: "select", options: { "1024x1024": "正方形 1024×1024", "1536x1024": "橫式 1536×1024", "1024x1536": "直式 1024×1536" }, default: "1024x1024" },
      n: { label: "張數", type: "number", default: 1 },
      filename: { label: "檔名", type: "text", default: "圖片-{{today}}" },
    },
    out: "images",
  },
  survey: {
    label: "問卷分析",
    desc: "讀取 Google 表單等匯出的 CSV／Excel，自動判斷題型並產生統計表、圖表（Word／Excel／HTML）；個資欄位不分析",
    fields: {
      fileId: { label: "問卷資料檔（CSV／Excel）", type: "file", default: "" },
      group: { label: "分組比較欄位（選填，填題目名稱）", type: "text", default: "" },
      title: { label: "報告標題", type: "text", default: "問卷分析報告" },
      ai: { label: "使用 AI 撰寫分析摘要與開放題歸納", type: "checkbox", default: false },
    },
    out: "survey",
  },
  format_check: {
    label: "報告格式檢查",
    desc: "依國科會／政府計畫成果報告常見格式逐項檢查 Word 檔（字型、字級、對齊、標號、架構、圖表、用語、參考文獻），可自動修正",
    fields: {
      fileId: { label: "報告檔（.docx／.doc／.odt）", type: "file", default: "" },
      profile: { label: "報告類型", type: "select", options: { auto: "自動判斷", academic: "學術型（國科會計畫、研究報告）", project: "計畫成果型（縣市計畫、委託案）" }, default: "auto" },
      fix: { label: "自動修正可修正的項目（另存新檔）", type: "checkbox", default: false },
    },
    out: "check",
  },
  pdf_tool: {
    label: "PDF 工具",
    desc: "合併、分割、擷取／刪除頁面、旋轉、加浮水印、加頁碼、壓縮、圖片轉 PDF（不使用 AI）",
    fields: {
      op: { label: "功能", type: "select", options: PDF_OPS, default: "merge" },
      fileIds: { label: "檔案（可多選，依順序處理）", type: "files", default: "" },
      ranges: { label: "頁碼範圍（例：1-3, 5, 8-）", type: "text", default: "" },
      splitMode: { label: "分割方式", type: "select", options: { each: "每頁一個檔", every: "每 N 頁一個檔", ranges: "依自訂範圍（用分號分隔各檔）" }, default: "each" },
      every: { label: "每幾頁一個檔", type: "number", default: 2 },
      text: { label: "浮水印文字／頁碼格式", type: "text", default: "" },
      tile: { label: "浮水印鋪滿整頁", type: "checkbox", default: false },
      position: { label: "頁碼位置", type: "select", options: { "bottom-center": "下方置中", "bottom-right": "右下角", "top-right": "右上角" }, default: "bottom-center" },
      skipFirst: { label: "封面不加頁碼", type: "checkbox", default: false },
      angle: { label: "旋轉角度", type: "select", options: { 90: "順時針 90°", 180: "180°", 270: "逆時針 90°" }, default: "90" },
      level: { label: "壓縮程度", type: "select", options: { low: "輕度（品質優先）", medium: "中度（建議）", high: "高度（檔案最小）" }, default: "medium" },
      filename: { label: "檔名", type: "text", default: "PDF-{{today}}" },
    },
    out: "pdf",
  },
  image_batch: {
    label: "圖片批次處理",
    desc: "縮放、轉格式、壓縮、移除拍攝資訊（含 GPS 位置），多張自動打包成 ZIP（不使用 AI）",
    fields: {
      fileIds: { label: "圖片（可多選）", type: "files", default: "" },
      width: { label: "最大寬度（像素，選填）", type: "number", default: "" },
      height: { label: "最大高度（像素，選填）", type: "number", default: "" },
      percent: { label: "依比例縮放（%，選填）", type: "number", default: "" },
      format: { label: "輸出格式", type: "select", options: IMAGE_FORMATS, default: "keep" },
      quality: { label: "品質（10–100）", type: "number", default: 80 },
      maxKB: { label: "每張檔案大小上限（KB，選填）", type: "number", default: "" },
      keepMeta: { label: "保留拍攝資訊（EXIF）", type: "checkbox", default: false },
      filename: { label: "壓縮檔名", type: "text", default: "圖片-{{today}}" },
    },
    out: "images",
  },
  webhook: {
    label: "發送通知",
    desc: "POST 到 Slack / Discord / Teams 等 Webhook",
    fields: { url: { label: "Webhook 網址（空白則用設定中的預設）", type: "text", default: "" }, message: { label: "訊息", type: "textarea", default: "{{ai}}" } },
    out: "",
  },
};

// ---------- 模板 ----------
function getPath(vars, p) {
  return p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), vars);
}

/** 將任何值轉成適合放進提示的文字 */
export function stringify(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v.__type === "page") return `# ${v.title}\n來源：${v.url}\n\n${compactText(v.markdown)}`;
  if (v.__type === "site") return v.pages.map((p) => `# ${p.title}\n來源：${p.url}\n\n${compactText(p.markdown)}`).join("\n\n---\n\n");
  if (v.__type === "table") return toMarkdownTable(v);
  if (v.__type === "doc") return v.text;
  if (v.__type === "check") return v.markdown;
  if (v.__type === "items") return v.results.map((r, i) => `## ${i + 1}. ${r.item.slice(0, 120)}\n\n${r.output}`).join("\n\n");
  if (v.__type === "file") return v.url;
  if (v.__type === "papers")
    return v.papers
      .map((p, i) => `### ${i + 1}. ${p.title}\n- 作者：${p.authors.slice(0, 6).join(", ")}${p.authors.length > 6 ? " 等" : ""}\n- 年份：${p.year}　來源：${p.venue}${p.cited != null ? `　被引用：${p.cited}` : ""}\n- 連結：${p.url}${p.pdf ? `\n- 開放全文：${p.pdf}` : ""}\n\n${p.abstract ? "摘要：" + p.abstract.slice(0, 1500) : "（無摘要）"}`)
      .join("\n\n");
  if (v.__type === "feed") return v.items.map((i) => `- [${i.title}](${i.link})（${i.feed}${i.date ? "，" + i.date : ""}）${i.summary ? "：" + i.summary.slice(0, 200) : ""}`).join("\n");
  if (v.__type === "diff") return v.markdown;
  if (v.__type === "transcript") return v.segments ? v.timed : v.text;
  if (v.__type === "images") return `已產生 ${v.files.length} 張圖片（請見「產出檔案」）。\n\n描述：${v.prompt}`;
  if (v.__type === "files") return v.markdown;
  if (v.__type === "stats") return `${v.markdown}\n\n## 前 5 筆資料\n\n${v.sample}`;
  return JSON.stringify(v, null, 2);
}

export function render(tpl, vars) {
  return String(tpl ?? "").replace(/\{\{\s*([\w.一-鿿-]+)\s*\}\}/g, (_, p) => stringify(getPath(vars, p)));
}

/** 若模板剛好是單一變數，取得原始值（保留表格、頁面等結構） */
function resolveRaw(tpl, vars) {
  const m = /^\s*\{\{\s*([\w.一-鿿-]+)\s*\}\}\s*$/.exec(String(tpl || ""));
  return m ? getPath(vars, m[1]) : render(tpl, vars);
}

function toList(v) {
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : stringify(x)));
  if (v?.__type === "site") return v.pages.map((p) => stringify({ ...p, __type: "page" }));
  if (v?.__type === "table") return v.rows.map((r) => Object.entries(r).map(([k, x]) => `${k}：${x}`).join("\n"));
  if (v?.__type === "items") return v.results.map((r) => r.output);
  if (v?.__type === "papers") return v.papers.map((p) => `${p.title}（${p.year}，${p.venue}）\n${p.abstract || "（無摘要）"}`);
  if (v?.__type === "feed") return v.items.map((i) => i.link || i.title);
  return stringify(v)
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------- 檔案庫 ----------
const FILES_DIR = path.join(DATA_DIR, "files");
fs.mkdirSync(FILES_DIR, { recursive: true });

export function listFiles() {
  return load("files-index", []);
}
const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const rawPath = (meta) => path.join(FILES_DIR, meta.id + (meta.ext || ""));

/**
 * 加入檔案庫。保留原始檔（給文字辨識、資料分析使用）與擷取出的文字。
 * 圖片與掃描型 PDF 不會被拒絕，而是標記為「需文字辨識」。
 */
export async function addFile(name, buf) {
  const id = newId();
  const ext = path.extname(name).toLowerCase();
  let text = "";
  let kind;
  let pages;
  let needsOcr = false;
  let needsTranscribe = false;
  if (IMAGE_TYPES[ext] || IMAGE_INPUT.includes(ext) || AUDIO_TYPES[ext]) {
    if (!buf?.length) throw Object.assign(new Error("檔案是空的，沒有可處理的內容"), { status: 422 });
    kind = AUDIO_TYPES[ext] ? "audio" : "image";
    needsOcr = kind === "image";
    needsTranscribe = kind === "audio";
  } else {
    try {
      const parsed = await parseDocument(name, buf);
      text = parsed.text;
      kind = parsed.kind;
      pages = parsed.pages;
    } catch (e) {
      if (ext === ".pdf" && /掃描|沒有可擷取/.test(e.message)) {
        kind = "pdf";
        needsOcr = true;
      } else throw e;
    }
  }
  fs.writeFileSync(path.join(FILES_DIR, id + ".txt"), text);
  fs.writeFileSync(path.join(FILES_DIR, id + ext), buf);
  const meta = { id, name, ext, kind, pages, chars: text.length, size: buf.length, needsOcr, needsTranscribe, addedAt: new Date().toISOString() };
  save("files-index", [meta, ...listFiles()]);
  return { ...meta, text };
}
export function getFileMeta(id) {
  const meta = listFiles().find((f) => f.id === id);
  if (!meta) throw Object.assign(new Error(id ? "找不到檔案，可能已被刪除，請重新選擇" : "請先選擇或上傳檔案"), { status: 400 });
  return meta;
}
export function getFileText(id) {
  const meta = getFileMeta(id);
  if (meta.needsTranscribe) throw Object.assign(new Error(`「${meta.name}」是音檔，請使用「錄音轉逐字稿」或「會議錄音整理」服務先轉成文字`), { status: 422 });
  if (meta.needsOcr) throw Object.assign(new Error(`「${meta.name}」是掃描檔或圖片，沒有文字可讀取。請使用「掃描文件文字辨識」服務先轉成文字`), { status: 422 });
  return { meta, text: fs.readFileSync(path.join(FILES_DIR, id + ".txt"), "utf8") };
}
export function getFileRaw(id) {
  const meta = getFileMeta(id);
  const p = rawPath(meta);
  if (!fs.existsSync(p)) throw Object.assign(new Error(`「${meta.name}」是舊版本上傳的檔案，沒有保存原始檔，請重新上傳`), { status: 422 });
  return { meta, buf: fs.readFileSync(p) };
}
export function deleteFile(id) {
  const meta = listFiles().find((f) => f.id === id);
  save("files-index", listFiles().filter((f) => f.id !== id));
  fs.rmSync(path.join(FILES_DIR, id + ".txt"), { force: true });
  if (meta) fs.rmSync(rawPath(meta), { force: true });
}

/** AI 只接受 PNG／JPG／WEBP／GIF：其他圖片格式先轉成 PNG；過大的圖片縮小以節省用量 */
async function toModelImage(meta, buf) {
  if (!IMAGE_TYPES[meta.ext] && !IMAGE_INPUT.includes(meta.ext)) return { buf, type: null };
  let m;
  try {
    m = await sharp(buf).metadata();
  } catch {
    if (IMAGE_TYPES[meta.ext]) return { buf, type: IMAGE_TYPES[meta.ext] };
    throw Object.assign(new Error(`「${meta.name}」無法讀取為圖片${/hei[cf]/.test(meta.ext) ? "（HEIC 請先轉成 JPG）" : ""}`), { status: 422 });
  }
  if (IMAGE_TYPES[meta.ext] && buf.length <= 4.5 * 1024 * 1024 && Math.max(m.width, m.height) <= 3000) return { buf, type: IMAGE_TYPES[meta.ext] };
  const out = await sharp(buf).rotate().resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  return { buf: out, type: "image/png" };
}

// ---------- 服務表單 ----------
/**
 * 文件來源 → { __type: "doc", name, text }
 * v：{ kind: "file", fileId } | { kind: "text", text } | { kind: "url", url } | 純文字
 */
export async function resolveDocSource(v, { signal } = {}) {
  if (v && typeof v === "object" && v.kind === "file") {
    const { meta, text } = getFileText(v.fileId);
    return { __type: "doc", name: meta.name, text };
  }
  if (v && typeof v === "object" && v.kind === "url") {
    const p = await scrapePage(v.url, { signal });
    return { __type: "doc", name: p.title || v.url, text: `# ${p.title}\n來源：${p.url}\n\n${p.markdown}`, url: p.url };
  }
  const text = typeof v === "object" ? v?.text : v;
  if (!String(text || "").trim()) throw Object.assign(new Error("請提供文件內容（上傳檔案、選擇檔案庫、貼上文字或輸入網址）"), { status: 400 });
  return { __type: "doc", name: "貼上的文字", text: String(text) };
}

/** 依服務欄位型別整理表單值：文件來源先轉成文字、勾選轉成 true/空字串 */
export async function prepareServiceForm(service, form = {}, { signal } = {}) {
  const out = {};
  for (const f of service.fields) {
    const v = form[f.key];
    if (f.type === "doc") out[f.key] = v ? await resolveDocSource(v, { signal }) : undefined;
    else if (f.type === "files") out[f.key] = (Array.isArray(v) ? v : String(v ?? "").split(",")).map((x) => String(x).trim()).filter(Boolean).join(",");
    else if (f.type === "checkbox") out[f.key] = v === true || v === "true" || v === "on" ? "true" : "";
    else out[f.key] = v == null ? (f.default ?? "") : String(v).trim();
  }
  return out;
}

// ---------- 執行 ----------
class StopFlow extends Error {}

function parseHeaders(text, vars) {
  const h = {};
  for (const line of render(text, vars).split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) h[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return h;
}

/** 數字、選單、勾選、檔案、知識庫欄位若使用 {{變數}}，執行前先代入實際值 */
function renderConfig(node, vars) {
  const def = NODE_TYPES[node.type];
  if (!def) return node;
  const out = { ...node };
  for (const [k, f] of Object.entries(def.fields)) {
    const v = node[k];
    if (typeof v !== "string" || !v.includes("{{")) continue;
    if (["number", "select", "checkbox", "file", "kb"].includes(f.type)) {
      const r = render(v, vars).trim();
      out[k] = f.type === "number" ? (r === "" ? "" : Number(r)) : f.type === "checkbox" ? !/^(|false|0|no|off)$/i.test(r) : r;
    }
  }
  return out;
}

async function runNode(rawNode, vars, ctx) {
  const node = renderConfig(rawNode, vars);
  const { emit, signal, flow } = ctx;
  const log = (m) => emit({ type: "log", node: node.id, message: m });
  const onText = (d) => emit({ type: "text", node: node.id, delta: d });
  const progress = ({ done, total }) => log(`進度 ${done}/${total}`);

  switch (node.type) {
    case "fetch_url": {
      const url = render(node.url, vars).trim();
      log(`擷取 ${url}`);
      const p = await scrapePage(url, { mode: node.mode, signal, log });
      log(`取得「${p.title}」，${p.markdown.length} 字`);
      return { __type: "page", url: p.url, title: p.title, markdown: p.markdown, links: p.links.slice(0, 200).map((l) => l.url) };
    }
    case "crawl": {
      const url = render(node.url, vars).trim();
      const r = await crawlSite(url, {
        maxPages: Number(node.maxPages) || 10,
        maxDepth: Number(node.maxDepth) || 2,
        include: render(node.include || "", vars).trim(),
        signal,
        onPage: (p, s) => log(p ? `完成 ${p.url}（第 ${s.done} 頁）` : `失敗 ${s.error}`),
      });
      return { __type: "site", start: url, pages: r.pages.map((p) => ({ url: p.url, title: p.title, markdown: p.markdown })), errors: r.errors };
    }
    case "http": {
      const url = render(node.url, vars).trim();
      const method = node.method || "GET";
      const headers = parseHeaders(node.headers || "", vars);
      const body = method === "GET" ? undefined : render(node.body || "", vars);
      if (body && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
      log(`${method} ${url}`);
      const res = await fetch(url, { method, headers, body, signal });
      const text = await res.text();
      log(`HTTP ${res.status}，${text.length} 字元`);
      if (!res.ok) throw new Error(`API 回應 HTTP ${res.status}：${text.slice(0, 200)}`);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    case "ocr": {
      const { meta, buf: raw } = getFileRaw(render(node.fileId, vars));
      const isPdf = meta.ext === ".pdf";
      const { buf, type: mediaType } = isPdf ? { buf: raw, type: "application/pdf" } : await toModelImage(meta, raw);
      if (!mediaType) throw Object.assign(new Error("文字辨識支援 PDF 與圖片（PNG、JPG、WEBP、GIF）"), { status: 422 });
      if (buf.length > 25 * 1024 * 1024) throw Object.assign(new Error("檔案超過 25 MB，請先分割後再辨識"), { status: 422 });
      log(`辨識「${meta.name}」中…（${isPdf ? "PDF" : "圖片"}，${Math.round(buf.length / 1024)} KB）`);
      const { text } = await generate(
        {
          prompt: `請將這份${isPdf ? "文件" : "圖片"}中的所有文字完整轉錄成文字，保留原本的段落、標題與表格（表格請用 Markdown 表格）。不要摘要、不要省略、不要加入說明。${render(node.instruction || "", vars)}`,
          attachments: [{ kind: isPdf ? "pdf" : "image", mediaType, data: buf.toString("base64"), name: meta.name }],
          maxTokens: 64000,
          light: true,
        },
        onText,
        signal,
      );
      return { __type: "doc", name: meta.name, text };
    }
    case "paper_search": {
      const papers = await searchPapers(render(node.query, vars), { source: node.source, limit: node.limit, fromYear: render(String(node.fromYear ?? ""), vars), sort: node.sort, signal });
      log(`找到 ${papers.length} 篇（${node.source === "arxiv" ? "arXiv" : "OpenAlex"}）`);
      return { __type: "papers", papers };
    }
    case "rss": {
      const urls = render(node.url, vars).split(/\s+/).filter((u) => /^https?:\/\//.test(u));
      if (!urls.length) throw Object.assign(new Error("請輸入 RSS 訂閱網址"), { status: 400 });
      const items = [];
      for (const u of urls) {
        try {
          const list = await readFeed(u, { limit: node.limit, sinceDays: node.sinceDays, signal });
          items.push(...list.map((i) => ({ ...i, feed: new URL(u).hostname })));
          log(`${u}：${list.length} 則`);
        } catch (e) {
          log(`${u}：讀取失敗（${e.message}）`);
        }
      }
      if (!items.length) throw Object.assign(new Error("所有訂閱來源都沒有讀到內容"), { status: 502 });
      return { __type: "feed", items };
    }
    case "cite": {
      const list = await formatCitations(render(node.source, vars), { style: node.style, signal });
      const ok = list.filter((c) => c.citation);
      log(`完成 ${ok.length}/${list.length} 筆${list.length > ok.length ? `，${list.length - ok.length} 筆查詢失敗` : ""}`);
      return list.map((c) => c.citation || `（${c.doi}：${c.error}）`).join(node.style === "bibtex" ? "\n\n" : "\n\n");
    }
    case "convert_zh":
      return convertChinese(stringify(resolveRaw(node.source, vars)), node.mode);
    case "compare": {
      const d = compareTexts(stringify(resolveRaw(node.a, vars)), stringify(resolveRaw(node.b, vars)));
      log(`新增 ${d.added} 字、刪除 ${d.removed} 字，共 ${d.changes.length} 處變動`);
      return { __type: "diff", ...d };
    }
    case "table_stats": {
      const { meta, buf } = getFileRaw(render(node.fileId, vars));
      const table = await parseTable(meta.name, buf);
      const st = tableStats(table);
      log(`${table.rows.length} 筆資料、${table.columns.length} 個欄位`);
      return { __type: "stats", markdown: st.markdown, rowCount: st.rowCount, sample: toMarkdownTable({ columns: table.columns, rows: table.rows.slice(0, 5) }) };
    }
    case "web_research": {
      const r = await generate(
        {
          system: "你是嚴謹的研究助理。請使用網路搜尋找出可靠、最新的資料，使用繁體中文撰寫，並在每個重點後標註來源。",
          prompt: render(node.prompt, vars),
          webSearch: { maxUses: Math.min(Number(node.maxSearches) || 5, 10) },
        },
        onText,
        signal,
      );
      const refs = (r.sources || []).map((x, i) => `${i + 1}. [${x.title}](${x.url})`).join("\n");
      return r.text + (refs ? `\n\n## 參考來源\n\n${refs}` : "");
    }
    case "transcribe": {
      const { meta, buf } = getFileRaw(render(node.fileId, vars));
      if (!AUDIO_TYPES[meta.ext]) throw Object.assign(new Error(`「${meta.name}」不是音檔。支援：${Object.keys(AUDIO_TYPES).join("、")}`), { status: 422 });
      log(`轉錄「${meta.name}」中…（${(buf.length / 1048576).toFixed(1)} MB）`);
      const r = await transcribe(buf, { name: meta.name, language: node.language, prompt: render(node.prompt || "", vars), signal, log });
      log(`完成（${r.provider}／${r.model}${r.parts > 1 ? `，分 ${r.parts} 段處理` : ""}），${r.text.length} 字${r.segments ? `、${r.segments.length} 句` : ""}`);
      return { __type: "transcript", name: meta.name, text: r.text, timed: r.segments ? toTimestamped(r.segments) : r.text, segments: r.segments || null };
    }
    case "image_ask": {
      const { meta, buf: raw } = getFileRaw(render(node.fileId, vars));
      const { buf, type } = await toModelImage(meta, raw);
      if (!type) throw Object.assign(new Error("圖片分析支援 PNG、JPG、WEBP、GIF、TIFF、BMP、AVIF、SVG"), { status: 422 });
      const { text } = await generate({ prompt: render(node.question, vars), system: "請使用繁體中文回答，以 Markdown 格式輸出。", attachments: [{ kind: "image", mediaType: type, data: buf.toString("base64"), name: meta.name }] }, onText, signal);
      return text;
    }
    case "image_gen": {
      const prompt = render(node.prompt, vars).trim();
      if (!prompt) throw Object.assign(new Error("請輸入圖片描述"), { status: 400 });
      log(`產生 ${Number(node.n) || 1} 張圖片中…`);
      const imgs = await generateImages(prompt, { size: node.size, n: node.n, signal });
      const base = render(node.filename || "圖片", vars);
      const files = imgs.map((im, i) => {
        const f = writeOutput(`${base}${imgs.length > 1 ? `-${i + 1}` : ""}.${im.ext}`, im.buf);
        emit({ type: "file", node: node.id, file: f });
        return f;
      });
      log(`完成 ${files.length} 張`);
      return { __type: "images", files, prompt };
    }
    case "survey": {
      const { meta, buf } = getFileRaw(render(node.fileId, vars));
      if (![".csv", ".tsv", ".txt", ".xlsx", ".xls", ".ods"].includes(meta.ext)) throw Object.assign(new Error("問卷分析需要 CSV 或 Excel 檔（Google 表單：回覆 → 下載回覆（.csv）；或在試算表選「檔案 → 下載 → CSV／Excel」）"), { status: 422 });
      const legacy = meta.ext === ".xls" || meta.ext === ".ods";
      const xbuf = legacy ? await convertWithOffice(buf, meta.ext, "xlsx") : buf;
      if (!xbuf) throw Object.assign(new Error(`無法讀取「${meta.name}」，請另存為 .xlsx 或 .csv 後再上傳`), { status: 422 });
      const table = await parseTable(legacy ? meta.name.replace(/\.\w+$/, ".xlsx") : meta.name, xbuf);
      if (!table.rows.length) throw Object.assign(new Error("檔案中沒有回覆資料"), { status: 422 });
      const group = render(node.group || "", vars).trim();
      if (group && !table.columns.includes(group)) throw Object.assign(new Error(`找不到分組欄位「${group}」。可用的欄位：${table.columns.slice(0, 15).join("、")}`), { status: 400 });
      const a = analyzeSurvey(table, { group: group || undefined });
      const counts = {};
      for (const q of a.questions) counts[q.type] = (counts[q.type] || 0) + 1;
      log(`${a.total} 份回覆；單選 ${counts.single || 0}、複選 ${counts.multi || 0}、量表 ${counts.scale || 0}、數值 ${counts.number || 0}、開放題 ${counts.text || 0} 題${a.personal.length ? `；個資欄位 ${a.personal.length} 個不分析` : ""}`);
      let narrative = "";
      let openSummary = "";
      if (node.ai) {
        const open = openAnswersForAI(a);
        const prompt = `以下是一份問卷的統計結果（已排除個人資料）。請用臺灣繁體中文、正式書面語撰寫：\n【分析摘要】3–5 段，說明整體結果、值得注意的發現（引用具體數字）${a.groups ? "、分組差異" : ""}，以及可行的建議。不要重複列出所有數字，不要使用破折號。${open ? "\n【開放題歸納】把開放題意見歸納成 3–6 個主題，每個主題說明代表性看法與大約則數。" : ""}\n只輸出上述段落，各段以【】標題開頭。\n\n# 統計結果\n${statsForAI(a)}${open ? `\n\n# 開放題意見\n${compactText(open).slice(0, 30000)}` : ""}`;
        const { text } = await generate({ prompt, maxTokens: 3000 }, onText, signal);
        const m = /【開放題歸納】([\s\S]*)$/.exec(text);
        openSummary = m ? m[1].trim() : "";
        narrative = (m ? text.slice(0, m.index) : text).replace(/【分析摘要】/, "").trim();
      }
      const title = render(node.title || "問卷分析報告", vars).trim() || "問卷分析報告";
      const md = surveyMarkdown(a, { title, narrative, openSummary });
      const images = {};
      const svgs = {};
      for (const [i, q] of a.questions.entries()) {
        const svg = chartFor(q);
        if (!svg) continue;
        svgs[`chart:${i}`] = svg;
        const png = await svgToPng(svg);
        const m = await sharp(png).metadata();
        images[`chart:${i}`] = { data: png, width: Math.round(m.width / 2), height: Math.round(m.height / 2) };
      }
      const files = [];
      const out = (name, data) => {
        const f = writeOutput(name, data);
        emit({ type: "file", node: node.id, file: f });
        files.push(f);
      };
      out(`${title}.docx`, await markdownToDocx(md, { images }));
      out(`${title}-統計表.xlsx`, await surveyXlsx(a));
      const tokens = [];
      const htmlMd = md.replace(/^!\[([^\]]*)\]\((chart:\d+)\)\s*$/gm, (_, cap, id) => {
        tokens.push(`<figure style="margin:8px 0">${svgs[id] || ""}<figcaption style="text-align:center">${cap.replace(/[<>&]/g, "")}</figcaption></figure>`);
        return `@@FIG${tokens.length - 1}@@`;
      });
      const body = miniMarkdown(htmlMd).replace(/(?:<p>)?@@FIG(\d+)@@(?:<\/p>)?/g, (_, n) => tokens[n]);
      out(`${title}.html`, surveyHtml(a, body));
      log(`已產生 Word、Excel、HTML 報告（${Object.keys(images).length} 張圖表）`);
      return { __type: "doc", name: title, text: md.replace(/^!\[[^\]]*\]\(chart:\d+\)\s*$/gm, "").replace(/\n{3,}/g, "\n\n"), files };
    }
    case "format_check": {
      const { meta, buf: raw } = getFileRaw(render(node.fileId, vars));
      let buf = raw;
      if (meta.ext === ".doc" || meta.ext === ".odt" || meta.ext === ".rtf") {
        log(`將「${meta.name}」轉為 .docx…`);
        buf = await convertWithOffice(raw, meta.ext, "docx");
        if (!buf) throw Object.assign(new Error(`格式檢查需要 .docx 檔。請用 Word 開啟「${meta.name}」後「另存新檔 → Word 文件（.docx）」再上傳（或安裝 LibreOffice 以自動轉換）`), { status: 422 });
      } else if (meta.ext !== ".docx") throw Object.assign(new Error("格式檢查需要 Word 檔（.docx）。PDF 無法檢查字型與樣式設定，請上傳原始 Word 檔"), { status: 422 });
      const profile = node.profile || "auto";
      const r = await checkDocx(buf, profile);
      const fail = r.results.filter((x) => x.status === "未通過").length;
      const warn = r.results.filter((x) => x.status === "提醒").length;
      const typeName = { academic: "學術型報告", project: "計畫成果型報告" }[r.type] || r.type;
      log(`判斷為${typeName}；${r.results.length} 項檢查：未通過 ${fail} 項、提醒 ${warn} 項`);
      const base = meta.name.replace(/\.\w+$/, "");
      let md = resultsToMarkdown(r, `「${base}」格式檢查`);
      const files = [];
      if (node.fix) {
        const fixed = await fixDocx(buf);
        const f = writeOutput(`${base}-格式修正.docx`, fixed.buf);
        emit({ type: "file", node: node.id, file: f });
        files.push(f);
        const r2 = await checkDocx(fixed.buf, profile);
        const fail2 = r2.results.filter((x) => x.status === "未通過").length;
        log(`已自動修正 ${fixed.changedParagraphs} 個段落與樣式；修正後未通過 ${fail2} 項`);
        md += `\n\n## 自動修正結果\n\n已另存「${base}-格式修正.docx」：修正 ${fixed.changedParagraphs} 個段落及內文、標題、圖表標題樣式的字型字級、對齊、行距與全半形，並設定開檔時更新功能變數。未通過項目由 ${fail} 項減為 ${fail2} 項。\n\n仍需人工處理的項目：\n\n${r2.results.filter((x) => x.status === "未通過").map((x) => `- ${x.item}：${x.detail}`).join("\n") || "（無）"}`;
      }
      return { __type: "check", markdown: md, text: compactText(r.text).slice(0, 20000), type: typeName, fail, warn, files };
    }
    case "pdf_tool": {
      const R = (k) => render(node[k] ?? "", vars).trim();
      const op = node.op || "merge";
      const ids = String(render(node.fileIds, vars)).split(/[,\s]+/).filter(Boolean);
      if (!ids.length) throw Object.assign(new Error("請選擇檔案"), { status: 400 });
      const items = ids.map((id) => {
        const { meta, buf } = getFileRaw(id);
        return { name: meta.name, ext: meta.ext, buf };
      });
      if (op === "images") {
        const bad = items.find((x) => !IMAGE_INPUT.includes(x.ext));
        if (bad) throw Object.assign(new Error(`「${bad.name}」不是圖片`), { status: 422 });
      } else {
        const bad = items.find((x) => x.ext !== ".pdf");
        if (bad) throw Object.assign(new Error(`「${bad.name}」不是 PDF 檔${IMAGE_INPUT.includes(bad.ext) ? "（圖片請使用「圖片轉 PDF」功能）" : ""}`), { status: 422 });
        if (op !== "merge" && items.length > 1) log(`此功能一次處理一個檔案，將分別處理 ${items.length} 個檔案`);
      }
      const base = render(node.filename || "PDF", vars).trim() || "PDF";
      const outs = [];
      const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
      const lines = [];
      const stem = (it) => (items.length > 1 ? it.name.replace(/\.pdf$/i, "") : base);
      if (op === "merge") {
        const r = await pdf.mergePdfs(items);
        outs.push({ name: `${base}.pdf`, buf: r.buf });
        lines.push(`合併 ${items.length} 個檔案（${items.map((x) => x.name).join("、")}），共 ${r.pages} 頁。`);
      } else if (op === "images") {
        const r = await pdf.imagesToPdf(items, { pageSize: R("pageSize") || "a4" });
        outs.push({ name: `${base}.pdf`, buf: r.buf });
        lines.push(`${items.length} 張圖片轉成 ${r.pages} 頁 PDF。`);
      } else {
        for (const it of items) {
          if (op === "split") {
            const parts = await pdf.splitPdf(it.buf, { mode: node.splitMode, every: node.every, ranges: render(node.ranges || "", vars), name: it.name });
            parts.forEach((p) => outs.push({ name: `${stem(it)}-第${p.label}頁.pdf`, buf: p.buf }));
            lines.push(`「${it.name}」分割成 ${parts.length} 個檔案。`);
          } else if (op === "extract") {
            const r = await pdf.extractPages(it.buf, render(node.ranges || "", vars), it.name);
            outs.push({ name: `${stem(it)}-擷取.pdf`, buf: r.buf });
            lines.push(`「${it.name}」（${r.total} 頁）擷取 ${r.pages} 頁。`);
          } else if (op === "delete") {
            if (!render(node.ranges || "", vars).trim()) throw Object.assign(new Error("請輸入要刪除的頁碼"), { status: 400 });
            const r = await pdf.deletePages(it.buf, render(node.ranges, vars), it.name);
            outs.push({ name: `${stem(it)}-刪頁.pdf`, buf: r.buf });
            lines.push(`「${it.name}」刪除 ${r.total - r.pages} 頁，剩 ${r.pages} 頁。`);
          } else if (op === "rotate") {
            const r = await pdf.rotatePdf(it.buf, node.angle, render(node.ranges || "", vars), it.name);
            outs.push({ name: `${stem(it)}-旋轉.pdf`, buf: r.buf });
            lines.push(`「${it.name}」旋轉 ${r.pages} 頁。`);
          } else if (op === "watermark") {
            const r = await pdf.watermarkPdf(it.buf, { text: render(node.text || "", vars), tile: !!node.tile, opacity: R("opacity"), size: R("size"), color: R("color") || "gray", name: it.name });
            outs.push({ name: `${stem(it)}-浮水印.pdf`, buf: r.buf });
            lines.push(`「${it.name}」${r.pages} 頁已加上浮水印。`);
          } else if (op === "pagenum") {
            const r = await pdf.addPageNumbers(it.buf, { format: render(node.text || "", vars).trim() || "{n}", position: node.position, skipFirst: !!node.skipFirst, name: it.name });
            outs.push({ name: `${stem(it)}-頁碼.pdf`, buf: r.buf });
            lines.push(`「${it.name}」${r.pages} 頁已加上頁碼。`);
          } else if (op === "compress") {
            log(`壓縮「${it.name}」中…`);
            const r = await pdf.compressPdf(it.buf, { level: node.level, name: it.name });
            outs.push({ name: `${stem(it)}-壓縮.pdf`, buf: r.buf });
            lines.push(`「${it.name}」${kb(r.before)} → ${kb(r.after)}（減少 ${Math.max(0, Math.round((1 - r.after / r.before) * 100))}%，${r.method}）。`);
            if (!r.ghostscript && r.after > r.before * 0.9) lines.push("（此檔以文字、向量為主，可壓縮空間有限；若安裝 Ghostscript，系統會自動使用以取得更好的壓縮效果。）");
          } else throw Object.assign(new Error(`未知的 PDF 功能：${op}`), { status: 400 });
        }
      }
      lines.forEach((l) => log(l));
      const files = [];
      if (outs.length > 1) {
        const zip = new JSZip();
        const used = new Set();
        for (const o of outs) {
          let n = o.name;
          for (let k = 2; used.has(n); k++) n = o.name.replace(/\.pdf$/, `-${k}.pdf`);
          used.add(n);
          zip.file(n, o.buf);
        }
        const f = writeOutput(`${base}.zip`, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
        emit({ type: "file", node: node.id, file: f });
        files.push(f);
      } else {
        const f = writeOutput(outs[0].name, outs[0].buf);
        emit({ type: "file", node: node.id, file: f });
        files.push(f);
      }
      return { __type: "files", files, markdown: `# PDF 處理結果（${PDF_OPS[op]}）\n\n${lines.map((l) => "- " + l).join("\n")}${outs.length > 1 ? `\n\n共 ${outs.length} 個檔案，已打包成 ZIP。` : ""}` };
    }
    case "image_batch": {
      const ids = String(render(node.fileIds, vars)).split(/[,\s]+/).filter(Boolean);
      if (!ids.length) throw Object.assign(new Error("請選擇圖片"), { status: 400 });
      const items = ids.map((id) => {
        const { meta, buf } = getFileRaw(id);
        if (!IMAGE_INPUT.includes(meta.ext)) throw Object.assign(new Error(`「${meta.name}」不是圖片。支援：${IMAGE_INPUT.join("、")}`), { status: 422 });
        return { name: meta.name, buf };
      });
      const r = await batchImages(items, { width: node.width, height: node.height, percent: node.percent, format: node.format, quality: node.quality, maxKB: node.maxKB, keepMeta: !!node.keepMeta }, { log });
      const base = render(node.filename || "圖片", vars).trim() || "圖片";
      const files = [];
      if (r.results.length === 1) files.push(writeOutput(r.results[0].name, r.results[0].buf));
      else {
        const zip = new JSZip();
        for (const x of r.results) zip.file(x.name, x.buf);
        files.push(writeOutput(`${base}.zip`, await zip.generateAsync({ type: "nodebuffer" })));
      }
      files.forEach((f) => emit({ type: "file", node: node.id, file: f }));
      return { __type: "files", files, markdown: r.markdown };
    }
    case "read_file": {
      const { meta, text } = getFileText(render(node.fileId, vars));
      log(`讀取「${meta.name}」，${text.length} 字`);
      return { __type: "doc", name: meta.name, text };
    }
    case "kb_search": {
      const k = kb.getKb(render(node.kbId, vars));
      const hits = kb.search(k, render(node.query, vars), Number(node.k) || 6);
      log(`找到 ${hits.length} 段相關內容`);
      return hits.map((h, i) => `[${i + 1}] 《${h.title}》\n${h.text}`).join("\n\n---\n\n") || "（知識庫中沒有找到相關內容）";
    }
    case "kb_add": {
      const src = resolveRaw(node.source, vars);
      let added = 0;
      if (src?.__type === "site") {
        for (const p of src.pages) {
          kb.addDocument(render(node.kbId, vars), { title: p.title || p.url, text: p.markdown, source: p.url, kind: "web" });
          added++;
        }
      } else {
        kb.addDocument(render(node.kbId, vars), { title: render(node.title, vars) || "工作流內容", text: stringify(src), source: src?.url || "", kind: src?.__type || "text" });
        added = 1;
      }
      log(`已存入 ${added} 份文件`);
      return { added };
    }
    case "llm": {
      const { text } = await generate({ prompt: render(node.prompt, vars), system: render(node.system || "", vars) || "請使用繁體中文回答，以 Markdown 格式輸出。", light: !!node.light }, onText, signal);
      return text;
    }
    case "llm_each": {
      const list = toList(resolveRaw(node.list, vars)).slice(0, 50);
      log(`共 ${list.length} 項`);
      // 1. 先取得每一項的內容（網址就先擷取）
      const items = [];
      const results = new Array(list.length);
      for (const [i, item] of list.entries()) {
        if (signal?.aborted) throw new Error("已取消");
        let content = item;
        if (node.fetch && /^https?:\/\//.test(item)) {
          try {
            const p = await scrapePage(item, { signal, log });
            content = `# ${p.title}\n來源：${p.url}\n\n${compactText(p.markdown).slice(0, 30000)}`;
          } catch (e) {
            results[i] = { item, output: `（擷取失敗：${e.message}）` };
            log(`失敗 ${i + 1}/${list.length}：${e.message}`);
            continue;
          }
        }
        items.push({ i, item, content });
      }
      // 2. 合併成批次，一次請 AI 處理多項（N 項通常只需 1 次呼叫，而不是 N 次）
      const budget = Math.min(chunkLimits().extract, 60000);
      const batches = [];
      let cur = [];
      let size = 0;
      for (const it of items) {
        if (cur.length && (size + it.content.length > budget || cur.length >= 20)) {
          batches.push(cur);
          cur = [];
          size = 0;
        }
        cur.push(it);
        size += it.content.length;
      }
      if (cur.length) batches.push(cur);
      const schema = { type: "object", properties: { results: { type: "array", items: { type: "string" } } }, required: ["results"], additionalProperties: false };
      for (const batch of batches) {
        if (signal?.aborted) throw new Error("已取消");
        let outputs = null;
        if (batch.length > 1) {
          const blocks = batch.map((it, k) => `<item id="${k + 1}">\n${render(node.prompt, { ...vars, item: it.content, index: it.i + 1 })}\n</item>`).join("\n\n");
          try {
            const data = await generateJson(
              `以下有 ${batch.length} 個獨立的工作，請分別完成每一個 <item> 中的要求，彼此不要混用內容。\n輸出 {"results":["第1項的結果","第2項的結果",...]}，共 ${batch.length} 個字串，順序與 id 相同；每個結果可使用 Markdown。\n\n${blocks}`,
              { system: "請使用繁體中文回答。", schema, light: false, signal },
            );
            if (Array.isArray(data.results) && data.results.length === batch.length) outputs = data.results.map(String);
            else log("AI 回傳的項目數量不符，改為逐項處理");
          } catch (e) {
            if (signal?.aborted) throw e;
            log(`批次處理失敗（${e.message}），改為逐項處理`);
          }
        }
        if (!outputs) {
          outputs = [];
          for (const it of batch) {
            const { text } = await generate({ prompt: render(node.prompt, { ...vars, item: it.content, index: it.i + 1 }), system: "請使用繁體中文回答。" }, undefined, signal);
            outputs.push(text);
          }
        }
        batch.forEach((it, k) => (results[it.i] = { item: it.item, output: outputs[k] }));
        log(`完成 ${results.filter(Boolean).length}/${list.length}（本批 ${batch.length} 項，1 次呼叫）`);
      }
      return { __type: "items", results: results.filter(Boolean) };
    }
    case "translate":
      return translate(stringify(resolveRaw(node.source, vars)), { target: node.target, glossary: render(node.glossary || "", vars), onText, onProgress: progress, signal });
    case "summarize":
      return summarize(stringify(resolveRaw(node.source, vars)), { style: render(node.style, vars), onText, onProgress: progress, signal });
    case "extract": {
      const t = await extractTable(stringify(resolveRaw(node.source, vars)), { fields: render(node.fields, vars), instruction: render(node.instruction, vars), onProgress: progress, signal });
      log(`擷取到 ${t.rows.length} 筆資料`);
      return { __type: "table", ...t };
    }
    case "site_check": {
      const STEP_NAMES = { dns: "DNS 記錄", http: "連線與回應時間", security: "安全標頭", ssl: "SSL 憑證", seo: "SEO 與頁面資訊", files: "robots.txt／sitemap", links: "站內連結", score: "評分" };
      const r = await checkSite(render(node.url, vars), { signal, onStep: (s) => log(`已檢查：${STEP_NAMES[s] || s}`) });
      log(`分數 ${r.score.score}（${r.score.grade}），${r.score.issues.length} 個問題`);
      return { __type: "check", score: r.score.score, grade: r.score.grade, issues: r.score.issues.map((i) => `【${i.level}】${i.msg}`).join("\n"), markdown: reportToMarkdown(r), host: r.host };
    }
    case "condition": {
      const left = render(node.left, vars);
      const right = render(node.right, vars);
      let ok;
      switch (node.op) {
        case "lt": ok = Number(left) < Number(right); break;
        case "gt": ok = Number(left) > Number(right); break;
        case "eq": ok = left.trim() === right.trim(); break;
        case "ne": ok = left.trim() !== right.trim(); break;
        case "contains": ok = left.includes(right); break;
        case "not_contains": ok = !left.includes(right); break;
        case "changed": {
          const memo = load("flow-memo", {});
          const key = `${flow.id}:${node.id}`;
          ok = memo[key] !== undefined && memo[key] !== left;
          if (memo[key] === undefined) log("第一次執行，記錄目前內容作為基準");
          memo[key] = left;
          save("flow-memo", memo);
          break;
        }
        default: ok = true;
      }
      const shortLeft = left.length > 40 ? left.slice(0, 40) + "…" : left;
      log(`「${shortLeft}」${NODE_TYPES.condition.fields.op.options[node.op]}「${right}」→ ${ok ? "成立，繼續" : "不成立，停止"}`);
      if (!ok) throw new StopFlow();
      return undefined;
    }
    case "set":
      return render(node.value, vars);
    case "save_file": {
      const src = resolveRaw(node.source, vars);
      const fmt = node.format || "md";
      const base = render(node.filename || "output", vars);
      let data;
      if (fmt === "csv" || fmt === "xlsx") {
        const table = src?.__type === "papers" ? papersToTable(src.papers) : src?.__type === "table" ? src : Array.isArray(src) && src.length && typeof src[0] === "object" ? { columns: Object.keys(src[0]), rows: src } : null;
        if (!table) throw new Error("CSV / Excel 需要表格資料（例如「擷取成表格」節點的輸出）");
        data = fmt === "csv" ? toCsv(table) : await toXlsx(table);
      } else if (fmt === "json") data = JSON.stringify(src?.__type === "papers" ? src.papers : src, null, 2);
      else if (fmt === "docx") data = await markdownToDocx(stringify(src), { formal: !!node.formal });
      else if (fmt === "srt" || fmt === "vtt") {
        if (src?.__type !== "transcript" || !src.segments) throw Object.assign(new Error("字幕檔需要含時間軸的逐字稿（使用 OpenAI 或 Groq 的 Whisper 模型轉錄）"), { status: 422 });
        data = fmt === "srt" ? toSrt(src.segments) : toVtt(src.segments);
      } else data = stringify(src);
      const f = writeOutput(`${base}.${fmt}`, data);
      log(`已儲存「${f.name.replace(/^\d+_/, "")}」`);
      emit({ type: "file", node: node.id, file: f });
      return { __type: "file", ...f };
    }
    case "webhook": {
      const url = render(node.url, vars).trim() || ctx.settings.webhookUrl;
      if (!url) throw new Error("沒有 Webhook 網址（節點或設定頁都未填）");
      const message = render(node.message, vars).slice(0, 3900);
      // 同時提供 Slack（text）與 Discord（content）格式
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: message, content: message.slice(0, 1990) }), signal });
      log(`通知已送出（HTTP ${res.status}）`);
      if (!res.ok) throw new Error(`Webhook 回應 HTTP ${res.status}`);
      return undefined;
    }
    default:
      throw new Error(`未知節點類型：${node.type}`);
  }
}

/**
 * 執行工作流。emit 事件：node-start / log / text / file / node-done / node-error / stopped / done
 */
export async function runFlow(flow, opts = {}) {
  const { result, usage } = await withUsage(() => runFlowInner(flow, opts));
  result.usage = usage;
  // 把用量補記到執行紀錄
  const runs = load("runs", []);
  const r = runs.find((x) => x.id === result.id);
  if (r) {
    r.usage = usage;
    save("runs", runs);
  }
  opts.emit?.({ type: "usage", usage });
  return result;
}

async function runFlowInner(flow, { input = "", emit = () => {}, signal, settings = {}, trigger = "manual", vars: extra = {} } = {}) {
  const now = new Date();
  const vars = {
    ...extra,
    input,
    today: now.toLocaleDateString("sv-SE"),
    now: now.toLocaleString("zh-TW", { hour12: false }),
  };
  const run = { id: newId(), flowId: flow.id, flowName: flow.name, trigger, input, startedAt: now.toISOString(), status: "running", logs: [], files: [] };
  const record = (ev) => {
    if (ev.type === "log") run.logs.push(`[${ev.node}] ${ev.message}`);
    if (ev.type === "file") run.files.push(ev.file);
    emit(ev);
  };
  const ctx = { emit: record, signal, flow, settings };
  let lastOutput;
  try {
    for (const [i, node] of (flow.nodes || []).entries()) {
      if (node.disabled) continue;
      // 條件式節點：when 的值為空、false、0、no 時略過（用於「勾選才執行」的選項）
      if (node.when !== undefined && /^(|false|0|no|off|undefined)$/i.test(render(node.when, vars).trim())) {
        record({ type: "node-skip", node: node.id, index: i });
        continue;
      }
      if (signal?.aborted) throw new Error("已取消");
      record({ type: "node-start", node: node.id, index: i, label: node.title || NODE_TYPES[node.type]?.label });
      try {
        const out = await runNode(node, vars, ctx);
        const varName = node.out ?? NODE_TYPES[node.type]?.out;
        if (varName && out !== undefined) vars[varName] = out;
        // 最終輸出顯示「最後一個有內容的結果」，略過輸出檔案、存入知識庫這類只回傳狀態的節點
        if (out !== undefined && !["file"].includes(out?.__type) && !["save_file", "kb_add"].includes(node.type)) lastOutput = out;
        record({ type: "node-done", node: node.id, index: i, var: varName, preview: stringify(out).slice(0, 1500) });
      } catch (e) {
        if (e instanceof StopFlow) {
          run.status = "stopped";
          record({ type: "stopped", node: node.id, index: i });
          break;
        }
        record({ type: "node-error", node: node.id, index: i, message: e.message });
        throw e;
      }
    }
    if (run.status === "running") run.status = "success";
    run.output = stringify(lastOutput).slice(0, 200000);
    record({ type: "done", status: run.status, output: run.output, files: run.files, usage: { ...(currentUsage() || {}) } });
  } catch (e) {
    run.status = "error";
    run.error = e.message;
    record({ type: "error", message: e.message });
  } finally {
    run.finishedAt = new Date().toISOString();
    const runs = load("runs", []);
    runs.unshift({ ...run, output: run.output?.slice(0, 50000) });
    save("runs", runs.slice(0, 100));
  }
  return run;
}

// ---------- 工作流儲存 ----------
export function listFlows() {
  return load("flows", []);
}
export function getFlow(id) {
  return listFlows().find((f) => f.id === id);
}
export function saveFlow(flow) {
  const flows = listFlows();
  const f = { ...flow, id: flow.id || newId(), updatedAt: new Date().toISOString() };
  f.nodes = (f.nodes || []).map((n, i) => ({ ...n, id: n.id || `n${i + 1}` }));
  const i = flows.findIndex((x) => x.id === f.id);
  // 編輯器送來的副本可能帶著較舊的排程時間，保留較新的那個，避免重複執行
  const prevRun = i >= 0 ? flows[i].lastScheduledRun : undefined;
  if (prevRun && (!f.lastScheduledRun || prevRun > f.lastScheduledRun)) f.lastScheduledRun = prevRun;
  if (i >= 0) flows[i] = f;
  else flows.unshift(f);
  save("flows", flows);
  return f;
}
export function deleteFlow(id) {
  save("flows", listFlows().filter((f) => f.id !== id));
}

// ---------- 排程 ----------
/** schedule: { enabled, mode: "interval"|"daily", minutes, time: "HH:MM", input } */
export function isDue(flow, now = new Date()) {
  const s = flow.schedule;
  if (!s?.enabled) return false;
  const last = flow.lastScheduledRun ? new Date(flow.lastScheduledRun) : null;
  if (s.mode === "daily") {
    const [h, m] = String(s.time || "09:00").split(":").map(Number);
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    return now >= target && (!last || last < target);
  }
  const mins = Math.max(5, Number(s.minutes) || 60);
  return !last || now - last >= mins * 60000;
}

export function startScheduler(getSettingsFn, log = console.log) {
  const running = new Set();
  const tick = async () => {
    for (const flow of listFlows()) {
      if (running.has(flow.id) || !isDue(flow)) continue;
      running.add(flow.id);
      saveFlow({ ...flow, lastScheduledRun: new Date().toISOString() });
      log(`[排程] 執行「${flow.name}」`);
      (async () => {
        const vars = flow.serviceForm ? { form: await prepareServiceForm({ fields: flow.serviceFields || [] }, flow.serviceForm) } : {};
        return runFlow(flow, { input: flow.schedule.input || "", settings: getSettingsFn(), trigger: "schedule", vars });
      })()
        .catch((e) => ({ status: "error", error: e.message }))
        .then((r) => log(`[排程] 「${flow.name}」${r.status}${r.error ? "：" + r.error : ""}`))
        .finally(() => running.delete(flow.id));
    }
  };
  const t = setInterval(tick, 30000);
  setTimeout(tick, 3000);
  return () => clearInterval(t);
}

// ---------- 範本 ----------
export const TEMPLATES = [
  {
    name: "外文文章 → 繁中翻譯 + 摘要",
    description: "貼上英文（或任何語言）文章網址，自動擷取正文、翻成繁體中文、產生摘要，存成 Markdown 檔。",
    inputLabel: "文章網址",
    inputPlaceholder: "https://example.com/blog/post",
    nodes: [
      { id: "n1", type: "fetch_url", url: "{{input}}", mode: "article", out: "page" },
      { id: "n2", type: "translate", source: "{{page}}", target: "zh-TW", out: "translated" },
      { id: "n3", type: "summarize", source: "{{page}}", style: "三到五點重點條列，使用繁體中文", out: "summary" },
      { id: "n4", type: "set", value: "# {{page.title}}\n\n原文：{{page.url}}\n\n## 摘要\n\n{{summary}}\n\n## 全文翻譯\n\n{{translated}}", out: "text" },
      { id: "n5", type: "save_file", source: "{{text}}", format: "md", filename: "翻譯-{{today}}", out: "file" },
    ],
  },
  {
    name: "論文 PDF → 繁中翻譯 + 摘要",
    description: "適用於需要訂閱、無法直接擷取的期刊論文：先在瀏覽器下載 PDF，上傳到「檔案管理」，在第 1 個節點選擇檔案後執行。",
    inputLabel: "摘要重點（選填）",
    inputPlaceholder: "例如：著重研究方法與數值結果",
    nodes: [
      { id: "n1", type: "read_file", fileId: "", out: "doc" },
      { id: "n2", type: "summarize", source: "{{doc}}", style: "學術摘要（研究目的、方法、結果、結論）{{input}}", out: "summary" },
      { id: "n3", type: "translate", source: "{{doc}}", target: "zh-TW", out: "translated" },
      { id: "n4", type: "set", value: "# {{doc.name}}\n\n## 摘要\n\n{{summary}}\n\n## 全文翻譯\n\n{{translated}}", out: "text" },
      { id: "n5", type: "save_file", source: "{{text}}", format: "md", filename: "論文翻譯-{{today}}", out: "file" },
    ],
  },
  {
    name: "多網址每日簡報",
    description: "每行一個網址（新聞、部落格、公告頁），逐一擷取並摘要，最後整合成一份簡報並推送到 Slack / Discord。可設定每天自動執行。",
    inputLabel: "網址清單（每行一個）",
    inputPlaceholder: "https://news.example.com/a\nhttps://blog.example.com/b",
    nodes: [
      { id: "n1", type: "llm_each", list: "{{input}}", fetch: true, prompt: "用繁體中文以 2-3 句話摘要這篇內容，第一句寫出最重要的資訊：\n\n{{item}}", out: "items" },
      { id: "n2", type: "llm", prompt: "以下是今天收集的各篇摘要，請整合成一份「{{today}} 每日簡報」：開頭三行總結今天最重要的事，接著分類列出各則重點並附原始連結。\n\n{{items}}", out: "ai" },
      { id: "n3", type: "save_file", source: "{{ai}}", format: "md", filename: "每日簡報-{{today}}", out: "file" },
      { id: "n4", type: "webhook", url: "", message: "{{ai}}", disabled: true },
    ],
  },
  {
    name: "網站健康巡檢 + 異常通知",
    description: "檢測網站的 SSL、安全標頭、SEO、失效連結。分數低於門檻時，由 AI 寫出修正建議並發送通知。適合設成每天自動執行。",
    inputLabel: "網站網址",
    inputPlaceholder: "https://your-site.com",
    nodes: [
      { id: "n1", type: "site_check", url: "{{input}}", out: "check" },
      { id: "n2", type: "save_file", source: "{{check}}", format: "md", filename: "網站檢測-{{check.host}}-{{today}}", out: "file" },
      { id: "n3", type: "condition", left: "{{check.score}}", op: "lt", right: "85" },
      { id: "n4", type: "llm", prompt: "以下是網站檢測報告。請以繁體中文列出最該優先處理的 5 個問題，每個問題附上具體修正方法（例如 Nginx / Apache / Cloudflare 的設定範例）。\n\n{{check}}", out: "ai" },
      { id: "n5", type: "webhook", url: "", message: "{{check.host}} 檢測分數 {{check.score}}（{{check.grade}}）\n\n{{check.issues}}", disabled: true },
    ],
  },
  {
    name: "網頁變動監控",
    description: "定時檢查某個網頁（價格、公告、職缺頁…），內容有變動時由 AI 說明改了什麼並通知你。",
    inputLabel: "要監控的網址",
    inputPlaceholder: "https://example.com/pricing",
    nodes: [
      { id: "n1", type: "fetch_url", url: "{{input}}", mode: "full", out: "page" },
      { id: "n2", type: "set", value: "{{page.markdown}}", out: "text" },
      { id: "n3", type: "condition", left: "{{text}}", op: "changed", right: "" },
      { id: "n4", type: "llm", prompt: "網頁 {{page.url}} 的內容有更新。請用繁體中文簡短說明目前頁面的重點內容，特別是價格、日期、數字等資訊：\n\n{{text}}", out: "ai" },
      { id: "n5", type: "webhook", url: "", message: "網頁有變動：{{page.url}}\n\n{{ai}}", disabled: true },
    ],
  },
  {
    name: "文件 → Excel 表格",
    description: "從上傳的 PDF / Word（報價單、型錄、報告、名單…）擷取指定欄位，輸出 Excel。",
    inputLabel: "擷取條件（選填）",
    inputPlaceholder: "例如：只要 2024 年以後的項目",
    nodes: [
      { id: "n1", type: "read_file", fileId: "", out: "doc" },
      { id: "n2", type: "extract", source: "{{doc}}", fields: "項目, 數量, 單價, 金額, 備註", instruction: "{{input}}", out: "table" },
      { id: "n3", type: "save_file", source: "{{table}}", format: "xlsx", filename: "擷取結果-{{today}}", out: "file" },
    ],
  },
  {
    name: "網站 → 知識庫",
    description: "爬取整個網站（例如產品說明文件、FAQ），自動存進知識庫，之後就能在「知識庫問答」直接提問。",
    inputLabel: "網站起始網址",
    inputPlaceholder: "https://docs.example.com/",
    nodes: [
      { id: "n1", type: "crawl", url: "{{input}}", maxPages: 20, maxDepth: 2, include: "", out: "site" },
      { id: "n2", type: "kb_add", kbId: "", source: "{{site}}", title: "{{input}}", out: "kbResult" },
    ],
  },
  {
    name: "API 資料 → AI 分析報告",
    description: "呼叫任何 JSON API（此範例為 GitHub 公開 API），由 AI 解讀資料並產生報告。可換成你自己的內部 API。",
    inputLabel: "GitHub 專案（owner/repo）",
    inputPlaceholder: "nodejs/node",
    nodes: [
      { id: "n1", type: "http", method: "GET", url: "https://api.github.com/repos/{{input}}/issues?state=open&per_page=30", headers: "Accept: application/vnd.github+json\nUser-Agent: ai-studio", out: "api" },
      { id: "n2", type: "llm", prompt: "以下是 GitHub 專案 {{input}} 最新的 30 個未關閉 issue（JSON）。請用繁體中文分類整理：主要問題類型、最需要優先處理的 5 個 issue（附連結與理由）、整體觀察。\n\n{{api}}", out: "ai" },
      { id: "n3", type: "save_file", source: "{{ai}}", format: "md", filename: "issue分析-{{today}}", out: "file" },
    ],
  },
];
