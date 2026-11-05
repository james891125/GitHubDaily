// 不需要 AI 的工具（不花 API 用量），以及資料表解析
//  - 文獻搜尋：OpenAlex、arXiv（免金鑰）
//  - RSS / Atom 訂閱讀取
//  - 參考文獻格式：以 DOI 透過 Crossref 產生 APA / IEEE / Chicago / MLA / BibTeX
//  - 繁簡轉換（OpenCC，含台灣用詞）
//  - 文件比對（逐字差異）
//  - 資料表統計（數值欄位平均、最大最小、類別次數）
import path from "node:path";
import { createRequire } from "node:module";
import { parseHTML } from "linkedom";
import ExcelJS from "exceljs";
import { diffWordsWithSpace, diffLines } from "diff";
import { decodeText } from "./docs.js";

const require = createRequire(import.meta.url);
const OpenCC = require("opencc-js");
const UA = "AI-Studio/1.0 (local tool)";
const BASE = {
  openalex: process.env.SCHOLAR_OPENALEX_BASE || "https://api.openalex.org",
  crossref: process.env.SCHOLAR_CROSSREF_BASE || "https://api.crossref.org",
  arxiv: process.env.ARXIV_BASE || "https://export.arxiv.org",
};

const userError = (msg, status = 400) => Object.assign(new Error(msg), { status });

async function getText(url, { accept = "*/*", signal, timeout = 20000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  signal?.addEventListener("abort", () => ac.abort());
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept }, signal: ac.signal });
    const body = await res.text();
    if (!res.ok) throw userError(`HTTP ${res.status}：${body.slice(0, 120)}`, 502);
    return body;
  } catch (e) {
    if (e.status) throw e;
    throw userError(ac.signal.aborted ? "連線逾時" : `無法連線：${e.cause?.code || e.message}`, 502);
  } finally {
    clearTimeout(t);
  }
}

// ---------------- 文獻搜尋 ----------------
function invertedToText(idx) {
  if (!idx) return "";
  const words = [];
  for (const [w, ps] of Object.entries(idx)) for (const p of ps) words[p] = w;
  return words.filter(Boolean).join(" ");
}

/** @returns {Promise<Array<{title,authors,year,venue,doi,url,abstract,pdf,cited,source}>>} */
export async function searchPapers(query, { source = "openalex", limit = 10, fromYear, sort = "relevance", signal } = {}) {
  const q = String(query || "").trim();
  if (!q) throw userError("請輸入搜尋關鍵字");
  limit = Math.min(Math.max(Number(limit) || 10, 1), 50);
  if (source === "arxiv") {
    const sortBy = sort === "date" ? "submittedDate" : "relevance";
    const url = `${BASE.arxiv}/api/query?search_query=${encodeURIComponent("all:" + q)}&start=0&max_results=${limit}&sortBy=${sortBy}&sortOrder=descending`;
    const xml = await getText(url, { accept: "application/atom+xml", signal });
    const { document } = parseHTML(xml.replace(/<\?xml[^>]*>/, ""));
    return [...document.querySelectorAll("entry")]
      .map((e) => {
        const get = (sel) => e.querySelector(sel)?.textContent?.replace(/\s+/g, " ").trim() || "";
        const id = get("id");
        return {
          title: get("title"),
          authors: [...e.querySelectorAll("author name")].map((n) => n.textContent.trim()),
          year: get("published").slice(0, 4),
          venue: "arXiv",
          doi: get("arxiv\\:doi") || "",
          url: id,
          abstract: get("summary"),
          pdf: [...e.querySelectorAll("link")].find((l) => l.getAttribute("title") === "pdf")?.getAttribute("href") || id.replace("/abs/", "/pdf/"),
          cited: null,
          source: "arXiv",
        };
      })
      .filter((p) => !fromYear || Number(p.year) >= Number(fromYear));
  }
  const filters = ["type:article|preprint|review"];
  if (fromYear) filters.push(`from_publication_date:${Number(fromYear)}-01-01`);
  const sortParam = sort === "date" ? "&sort=publication_date:desc" : sort === "cited" ? "&sort=cited_by_count:desc" : "";
  const url = `${BASE.openalex}/works?search=${encodeURIComponent(q)}&filter=${encodeURIComponent(filters.join(","))}&per-page=${limit}${sortParam}`;
  const data = JSON.parse(await getText(url, { accept: "application/json", signal }));
  return (data.results || []).map((w) => ({
    title: w.title || w.display_name || "",
    authors: (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean),
    year: String(w.publication_year || ""),
    venue: w.primary_location?.source?.display_name || "",
    doi: (w.doi || "").replace(/^https?:\/\/doi\.org\//, ""),
    url: w.doi || w.id,
    abstract: invertedToText(w.abstract_inverted_index),
    pdf: w.best_oa_location?.pdf_url || w.open_access?.oa_url || "",
    cited: w.cited_by_count ?? null,
    source: "OpenAlex",
  }));
}

export function papersToTable(papers) {
  const columns = ["標題", "作者", "年份", "期刊／來源", "被引用次數", "DOI", "連結", "開放全文"];
  return {
    columns,
    rows: papers.map((p) => ({
      標題: p.title,
      作者: p.authors.slice(0, 6).join(", ") + (p.authors.length > 6 ? " 等" : ""),
      年份: p.year,
      "期刊／來源": p.venue,
      被引用次數: p.cited == null ? "" : String(p.cited),
      DOI: p.doi,
      連結: p.url,
      開放全文: p.pdf,
    })),
  };
}

// ---------------- RSS / Atom ----------------
export async function readFeed(url, { limit = 20, sinceDays, signal } = {}) {
  const xml = await getText(url, { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml", signal });
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(xml)) throw userError("這個網址不是 RSS / Atom 訂閱來源", 422);
  const { document } = parseHTML(xml.replace(/<\?xml[^>]*>/, ""));
  const nodes = [...document.querySelectorAll("item, entry")];
  const since = sinceDays ? Date.now() - Number(sinceDays) * 86400000 : 0;
  const strip = (s) => String(s || "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return nodes
    .map((n) => {
      const get = (sel) => n.querySelector(sel)?.textContent || "";
      const link = n.querySelector("link")?.getAttribute("href") || get("link").trim();
      const date = get("pubDate") || get("published") || get("updated") || get("dc\\:date");
      return { title: strip(get("title")), link, date: date ? new Date(date).toISOString().slice(0, 10) : "", time: date ? new Date(date).getTime() : 0, summary: strip(get("description") || get("summary") || get("content")).slice(0, 600) };
    })
    .filter((i) => i.title && (!since || !i.time || i.time >= since))
    .slice(0, Number(limit) || 20);
}

// ---------------- 參考文獻格式 ----------------
export const CITE_STYLES = { apa: "APA 第 7 版", ieee: "IEEE", "chicago-author-date": "Chicago（作者-年份）", "modern-language-association": "MLA", "harvard-cite-them-right": "Harvard", bibtex: "BibTeX" };

export function extractDois(text) {
  return [...new Set([...String(text || "").matchAll(/\b(10\.\d{4,9}\/[^\s"<>,;]+)/gi)].map((m) => m[1].replace(/[.)\]]+$/, "")))];
}

export async function formatCitations(text, { style = "apa", signal } = {}) {
  const dois = extractDois(text);
  if (!dois.length) throw userError("找不到 DOI。請每行貼上一個 DOI（例如 10.1016/j.enganabound.2017.10.009）或論文的 doi.org 網址");
  const out = [];
  for (const doi of dois.slice(0, 100)) {
    const url =
      style === "bibtex"
        ? `${BASE.crossref}/works/${encodeURIComponent(doi)}/transform/application/x-bibtex`
        : `${BASE.crossref}/works/${encodeURIComponent(doi)}/transform/text/x-bibliography?style=${encodeURIComponent(style)}`;
    try {
      out.push({ doi, citation: (await getText(url, { signal })).trim() });
    } catch (e) {
      out.push({ doi, citation: "", error: e.status === 502 && /404/.test(e.message) ? "查無此 DOI" : e.message });
    }
  }
  return out;
}

// ---------------- 繁簡轉換 ----------------
const converters = {};
export const ZH_MODES = { "s2twp": "簡體 → 繁體（台灣用詞，例：软件→軟體）", s2t: "簡體 → 繁體（僅轉字形）", "tw2sp": "繁體 → 簡體（大陸用詞）", t2s: "繁體 → 簡體（僅轉字形）" };
export function convertChinese(text, mode = "s2twp") {
  const map = { s2twp: ["cn", "twp"], s2t: ["cn", "tw"], tw2sp: ["twp", "cn"], t2s: ["tw", "cn"] };
  const [from, to] = map[mode] || map.s2twp;
  converters[mode] ||= OpenCC.Converter({ from, to });
  return converters[mode](String(text || ""));
}

// ---------------- 文件比對 ----------------
export function compareTexts(a, b, { labelA = "舊版", labelB = "新版" } = {}) {
  const A = String(a || "").replace(/\r\n?/g, "\n");
  const B = String(b || "").replace(/\r\n?/g, "\n");
  const lines = diffLines(A, B);
  const words = diffWordsWithSpace(A, B);
  const added = words.filter((p) => p.added).reduce((n, p) => n + p.value.replace(/\s/g, "").length, 0);
  const removed = words.filter((p) => p.removed).reduce((n, p) => n + p.value.replace(/\s/g, "").length, 0);
  const changes = [];
  const split = (v) => v.split("\n").map((x) => x.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const p = lines[i];
    if (p.removed && lines[i + 1]?.added) {
      // 連續多行變動：逐行配對，多出來的行視為新增或刪除
      const before = split(p.value);
      const after = split(lines[i + 1].value);
      for (let k = 0; k < Math.max(before.length, after.length); k++) {
        if (before[k] && after[k]) changes.push({ type: "修改", before: before[k], after: after[k] });
        else if (before[k]) changes.push({ type: "刪除", before: before[k], after: "" });
        else changes.push({ type: "新增", before: "", after: after[k] });
      }
      i++;
    } else if (p.removed) split(p.value).forEach((v) => changes.push({ type: "刪除", before: v, after: "" }));
    else if (p.added) split(p.value).forEach((v) => changes.push({ type: "新增", before: "", after: v }));
  }
  const md = [
    `# 文件比對結果`,
    "",
    `- ${labelA}：${A.replace(/\s/g, "").length} 字；${labelB}：${B.replace(/\s/g, "").length} 字`,
    `- 新增 ${added} 字、刪除 ${removed} 字，共 ${changes.length} 處變動`,
    "",
    changes.length ? `| 類型 | ${labelA} | ${labelB} |\n|---|---|---|\n` + changes.map((c) => `| ${c.type} | ${cell(c.before)} | ${cell(c.after)} |`).join("\n") : "兩份文件內容相同。",
  ].join("\n");
  // 逐字標示（HTML，用於畫面顯示）
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const html = words.map((p) => (p.added ? `<ins>${esc(p.value)}</ins>` : p.removed ? `<del>${esc(p.value)}</del>` : esc(p.value))).join("");
  return { added, removed, changes, markdown: md, html };
}
const cell = (s) => String(s || "").replace(/\|/g, "／").replace(/\n+/g, "<br>").slice(0, 500) || "—";

// ---------------- 資料表 ----------------
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let q = false;
  const sep = (text.split("\n")[0].match(/\t/g) || []).length > (text.split("\n")[0].match(/,/g) || []).length ? "\t" : ",";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) {
      row.push(cur);
      cur = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else cur += c;
  }
  if (cur || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

/** 讀取 CSV / Excel 成 { columns, rows }（第一列為欄位名稱） */
export async function parseTable(filename, buf) {
  const ext = path.extname(filename).toLowerCase();
  let grid;
  if (ext === ".csv" || ext === ".tsv" || ext === ".txt") grid = parseCsv(decodeText(buf));
  else if (ext === ".xlsx") {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    grid = [];
    ws.eachRow((r) =>
      grid.push(
        r.values.slice(1).map((v) => {
          if (v == null) return "";
          if (v instanceof Date) return v.toISOString().slice(0, 10);
          if (typeof v === "object") return String(v.result ?? v.text ?? (v.richText ? v.richText.map((t) => t.text).join("") : ""));
          return String(v);
        }),
      ),
    );
  } else throw userError("資料分析需要 CSV 或 Excel (.xlsx) 檔案", 422);
  if (grid.length < 2) throw userError("資料表至少需要標題列與一列資料", 422);
  const columns = grid[0].map((c, i) => String(c).trim() || `欄位${i + 1}`);
  const rows = grid.slice(1).map((r) => Object.fromEntries(columns.map((c, i) => [c, (r[i] ?? "").trim()])));
  return { columns, rows };
}

const toNum = (v) => {
  const s = String(v).replace(/[,\s$NT元%]/g, "");
  return s !== "" && !isNaN(Number(s)) ? Number(s) : null;
};

/** 在本機計算統計摘要（給 AI 寫分析時，只送摘要而不是整份資料，可大幅節省 token） */
export function tableStats({ columns, rows }) {
  const cols = columns.map((c) => {
    const vals = rows.map((r) => r[c]).filter((v) => v !== "" && v != null);
    const nums = vals.map(toNum).filter((n) => n !== null);
    if (vals.length && nums.length / vals.length >= 0.8) {
      const sorted = [...nums].sort((a, b) => a - b);
      const sum = nums.reduce((a, b) => a + b, 0);
      const mean = sum / nums.length;
      const sd = Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(nums.length - 1, 1));
      const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
      return { name: c, type: "數值", count: nums.length, missing: rows.length - vals.length, sum, mean, median, sd, min: sorted[0], max: sorted.at(-1) };
    }
    const freq = {};
    for (const v of vals) freq[v] = (freq[v] || 0) + 1;
    const top = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    return { name: c, type: "文字", count: vals.length, missing: rows.length - vals.length, unique: top.length, top: top.slice(0, 8) };
  });
  const r = (n) => (Math.abs(n) >= 100 ? Math.round(n).toLocaleString("en-US") : Number(n.toFixed(2)).toString());
  const md = [
    `# 資料統計摘要`,
    "",
    `共 ${rows.length} 筆資料、${columns.length} 個欄位。`,
    "",
    "## 數值欄位",
    "",
    "| 欄位 | 筆數 | 缺漏 | 總和 | 平均 | 中位數 | 標準差 | 最小 | 最大 |",
    "|---|---|---|---|---|---|---|---|---|",
    ...cols.filter((c) => c.type === "數值").map((c) => `| ${c.name} | ${c.count} | ${c.missing} | ${r(c.sum)} | ${r(c.mean)} | ${r(c.median)} | ${r(c.sd)} | ${r(c.min)} | ${r(c.max)} |`),
    "",
    "## 文字欄位（出現最多的值）",
    "",
    "| 欄位 | 筆數 | 不同值 | 前幾名（次數） |",
    "|---|---|---|---|",
    ...cols.filter((c) => c.type === "文字").map((c) => `| ${c.name} | ${c.count} | ${c.unique} | ${c.top.map(([v, n]) => `${String(v).slice(0, 20)}（${n}）`).join("、")} |`),
  ].join("\n");
  return { columns: cols, rowCount: rows.length, markdown: md };
}
