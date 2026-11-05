// 參考文獻查核：逐筆到 Crossref 確認文獻真的存在，比對作者、年份、期刊、卷期、頁碼與 DOI，
// 並依查到的正確資料產生 APA 第 7 版格式。可抓出 AI 寫作常見的「捏造文獻」與抄錯的書目資料。
// 不使用 AI；中文文獻（Crossref 收錄有限）只檢查格式。
import ExcelJS from "exceljs";

const BASE = { crossref: process.env.SCHOLAR_CROSSREF_BASE || "https://api.crossref.org" };
const UA = "AI-Studio/1.0 (local reference checker)";
const userError = (m) => Object.assign(new Error(m), { status: 422 });

// ---------------- 拆出每一筆文獻 ----------------
const MARKER = /^\s*(?:\[\d+\]|［\d+］|\(\d+\)|（\d+）|\d+[.．、)])\s*/;
const REF_HEAD = /^\s*(#+\s*)?(參考文獻|references|bibliography|literature cited|引用文獻)\s*$/i;

/** 從整份文件取出參考文獻段落；沒有標題時視為整段都是文獻清單 */
export function extractReferenceSection(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const i = lines.findIndex((l) => REF_HEAD.test(l.replace(/\*\*/g, "")));
  if (i < 0) return lines.join("\n");
  const rest = lines.slice(i + 1);
  // 到下一個主要標題（附錄等）為止
  const end = rest.findIndex((l) => /^\s*#{1,2}\s+\S/.test(l) || /^\s*(附錄|appendix)/i.test(l.replace(/[#*]/g, "")));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** 拆成一筆一筆：有編號就依編號切（可跨行），否則每個非空行一筆 */
export function splitReferences(text) {
  const lines = String(text || "")
    .split("\n")
    .map((l) => l.replace(/^\s*[-*•]\s+/, "").replace(/\*\*/g, "").trim())
    .filter((l) => l && !REF_HEAD.test(l));
  const numbered = lines.filter((l) => MARKER.test(l)).length;
  const out = [];
  if (numbered >= Math.max(2, lines.length * 0.5)) {
    for (const l of lines) {
      if (MARKER.test(l) || !out.length) out.push(l.replace(MARKER, ""));
      else out[out.length - 1] += (/[一-鿿]$/.test(out.at(-1)) ? "" : " ") + l;
    }
  } else out.push(...lines.map((l) => l.replace(MARKER, "")));
  return out.map((r) => r.replace(/\s+/g, " ").trim()).filter((r) => r.length >= 10);
}

// ---------------- 解析單筆文獻 ----------------
const isChinese = (r) => /^[一-鿿]/.test(r) || (r.match(/[一-鿿]/g) || []).length > r.length * 0.3;
export const extractDoi = (r) => /\b(10\.\d{4,9}\/[^\s"<>]+?)(?=[\s"<>]|[.,;)\]]*$|[.,;)\]]\s)/i.exec(r)?.[1] || null;

/** 粗略拆出年份、標題、第一作者姓氏、卷、期、頁碼（APA、IEEE、Chicago 等常見格式） */
export function parseReference(r) {
  const s = r.replace(/https?:\/\/(dx\.)?doi\.org\/\S+/gi, "").replace(/\bdoi:\s*\S+/gi, "");
  const year = /\((\d{4})[a-z]?\)/.exec(s)?.[1] || /(?:^|[\s,.])((?:19|20)\d{2})[a-z]?(?=[\s,.;)]|$)/.exec(s)?.[1] || null;
  let title = null;
  // APA：作者 (年份). 標題. 期刊…
  let m = /\(\d{4}[a-z]?\)\.\s*(.+?)[.?!]\s+(?=[A-Z])/.exec(s);
  if (m) title = m[1];
  // IEEE：作者, "標題," 期刊…
  if (!title && (m = /["“]([^"”]{10,}?)[,.]?["”]/.exec(s))) title = m[1];
  // 其他：取最長的一段
  if (!title) title = s.split(/\.\s+/).sort((a, b) => b.length - a.length)[0];
  const firstAuthor = /^([A-Z][A-Za-z'’\-]+(?:\s+[A-Z][A-Za-z'’\-]+)?)[,\s]/.exec(s)?.[1] || null;
  const vol = /,\s*(\d{1,4})\s*\((\d{1,4}[\-–]?\d*)\)/.exec(s) || /vol\.\s*(\d+)(?:,\s*no\.\s*(\d+))?/i.exec(s);
  const pages = /(?:pp?\.\s*)?(\d{1,6})\s*[\-–]\s*(\d{1,6})(?=[.,;\s]|$)/.exec(s.replace(/\(\d{4}\)/, ""));
  return { year, title: title?.trim() || "", firstAuthor, volume: vol?.[1] || null, issue: vol?.[2] || null, pages: pages ? `${pages[1]}-${pages[2]}` : null };
}

// ---------------- 相似度 ----------------
const words = (t) =>
  String(t || "")
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((w) => w.length > 1 && !["the", "of", "and", "for", "in", "on", "a", "an", "to", "with", "by"].includes(w));
/** 候選標題的字有多少比例出現在文獻中（文獻較長、含作者與期刊，所以只看標題被涵蓋的程度） */
export function titleCoverage(candTitle, ref) {
  const c = words(candTitle);
  if (!c.length) return 0;
  const r = new Set(words(ref));
  return c.filter((w) => r.has(w)).length / c.length;
}

// ---------------- Crossref ----------------
async function getJson(url, signal) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20000);
  signal?.addEventListener("abort", () => ac.abort());
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: ac.signal });
    if (res.status === 404) return null;
    if (res.status === 429) throw Object.assign(new Error("Crossref 查詢太頻繁，請稍後再試"), { status: 429 });
    if (!res.ok) throw new Error(`Crossref 回應 HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (signal?.aborted) throw new Error("已取消");
    if (e.name === "AbortError") throw new Error("Crossref 連線逾時");
    if (/fetch failed|ENOTFOUND|ECONNREFUSED/.test(e.message + (e.cause?.code || ""))) throw Object.assign(new Error("無法連線到 Crossref（請確認網路）"), { status: 502 });
    throw e;
  }
}

/** 把 Crossref 的資料整理成統一格式 */
export function normalizeWork(w) {
  const year = w.issued?.["date-parts"]?.[0]?.[0] || w.published?.["date-parts"]?.[0]?.[0] || w["published-print"]?.["date-parts"]?.[0]?.[0] || null;
  return {
    doi: w.DOI,
    title: String((w.title || [])[0] || "").replace(/<[^>]+>/g, ""),
    authors: (w.author || []).map((a) => ({ family: a.family || a.name || "", given: a.given || "" })),
    year: year ? String(year) : null,
    journal: (w["container-title"] || [])[0] || "",
    volume: w.volume || null,
    issue: w.issue || null,
    pages: w.page ? w.page.replace(/–/g, "-") : w["article-number"] || null,
    type: w.type || "",
  };
}

const initials = (given) =>
  String(given || "")
    .split(/[\s]+/)
    .filter(Boolean)
    .map((g) => g.split("-").map((p) => p[0].toUpperCase() + ".").join("-"))
    .join(" ");

/** APA 第 7 版（期刊論文） */
export function toApa(w) {
  const names = w.authors.map((a) => (a.given ? `${a.family}, ${initials(a.given)}` : a.family)).filter(Boolean);
  let au;
  if (!names.length) au = "";
  else if (names.length === 1) au = names[0];
  else if (names.length <= 20) au = names.slice(0, -1).join(", ") + ", & " + names.at(-1);
  else au = names.slice(0, 19).join(", ") + ", . . . " + names.at(-1);
  const title = w.title.replace(/\s+/g, " ").trim().replace(/[.]$/, "");
  const src = [w.journal, w.volume ? `${w.volume}${w.issue ? `(${w.issue})` : ""}` : "", w.pages || ""].filter(Boolean).join(", ");
  return `${au}${au ? " " : ""}(${w.year || "n.d."}). ${title}. ${src ? src + ". " : ""}https://doi.org/${w.doi}`.replace(/\.\./g, ".");
}

/** 比對文獻與查到的資料，列出差異 */
function compare(p, w, ref) {
  const diffs = [];
  if (p.year && w.year && p.year !== w.year) diffs.push(`年份應為 ${w.year}（文獻寫 ${p.year}）`);
  const fam = w.authors[0]?.family;
  if (fam && !new RegExp(fam.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(ref.normalize("NFD").replace(/[̀-ͯ]/g, ""))) diffs.push(`第一作者應為 ${fam}`);
  if (p.volume && w.volume && p.volume !== String(w.volume)) diffs.push(`卷數應為 ${w.volume}（文獻寫 ${p.volume}）`);
  if (p.issue && w.issue && p.issue !== String(w.issue)) diffs.push(`期數應為 ${w.issue}（文獻寫 ${p.issue}）`);
  if (p.pages && w.pages && /^\d+-\d+$/.test(w.pages) && p.pages !== w.pages) diffs.push(`頁碼應為 ${w.pages}（文獻寫 ${p.pages}）`);
  if (w.journal && titleCoverage(w.journal, ref) < 0.6) diffs.push(`期刊名稱應為 ${w.journal}`);
  return diffs;
}

/**
 * 查核一筆文獻
 * @returns {{ ref, status: "正確"|"有差異"|"查無此文獻"|"DOI 錯誤"|"中文未查核"|"無法判斷", detail, work?, apa? }}
 */
export async function checkReference(ref, { signal } = {}) {
  if (isChinese(ref)) {
    const ok = (ref.match(/，/g) || []).length >= 2 && /\d{4}[。.]?$/.test(ref.trim());
    return { ref, status: "中文未查核", detail: ok ? "中文文獻（Crossref 收錄有限，未線上查核）；格式符合「作者，篇名，來源，…，年份。」" : "中文文獻（未線上查核）；格式建議為「作者，篇名，來源，卷期頁碼，年份。」，以全形逗號分隔、年份結尾" };
  }
  const p = parseReference(ref);
  const doi = extractDoi(ref);
  if (doi) {
    const d = await getJson(`${BASE.crossref}/works/${encodeURIComponent(doi)}`, signal);
    if (!d?.message) {
      // DOI 查不到：改用標題搜尋，看看是不是 DOI 抄錯
      const found = await searchByTitle(ref, p, signal);
      if (found && found.score >= 0.85) return { ref, status: "DOI 錯誤", detail: `DOI ${doi} 不存在；依標題找到的正確 DOI 為 ${found.work.doi}`, work: found.work, apa: toApa(found.work) };
      return { ref, status: "查無此文獻", detail: `DOI ${doi} 不存在，依標題也找不到相符的文獻；可能是捏造或資料有誤，請查證原文` };
    }
    const w = normalizeWork(d.message);
    const cov = titleCoverage(w.title, ref);
    if (cov < 0.5) {
      // DOI 屬於另一篇：改依標題找這筆文獻本身
      const found = await searchByTitle(ref, p, signal);
      const other = `DOI ${doi} 對應的是另一篇文獻：「${w.title}」（${w.year}）`;
      if (found && found.score >= 0.85) return { ref, status: "DOI 錯誤", detail: `${other}；依標題找到的正確 DOI 為 ${found.work.doi}`, work: found.work, apa: toApa(found.work) };
      return { ref, status: "DOI 錯誤", detail: `${other}；依標題也找不到這筆文獻，請查證原文` };
    }
    const diffs = compare(p, w, ref);
    return { ref, status: diffs.length ? "有差異" : "正確", detail: diffs.join("；") || "與 Crossref 資料相符", work: w, apa: toApa(w) };
  }
  const found = await searchByTitle(ref, p, signal);
  if (!found || found.score < 0.6) return { ref, status: "查無此文獻", detail: found ? `最接近的是「${found.work.title}」（${found.work.year}），但相似度不足，可能是捏造或資料有誤，請查證原文` : "Crossref 找不到相符的文獻，可能是捏造或資料有誤；若為書籍、研討會論文、報告，Crossref 可能未收錄，請自行查證" };
  if (found.score < 0.85) return { ref, status: "無法判斷", detail: `可能是「${found.work.title}」（${found.work.year}，DOI ${found.work.doi}），標題差異較大，請確認`, work: found.work, apa: toApa(found.work) };
  const diffs = compare(p, found.work, ref);
  diffs.push(`缺少 DOI（${found.work.doi}）`);
  return { ref, status: diffs.length > 1 ? "有差異" : "正確", detail: diffs.length > 1 ? diffs.join("；") : `與 Crossref 資料相符；可補上 DOI ${found.work.doi}`, work: found.work, apa: toApa(found.work) };
}

async function searchByTitle(ref, p, signal) {
  const q = (p.title && p.title.length > 15 ? p.title + " " + (p.firstAuthor || "") + " " + (p.year || "") : ref).slice(0, 300);
  const d = await getJson(`${BASE.crossref}/works?query.bibliographic=${encodeURIComponent(q)}&rows=5&select=DOI,title,author,issued,container-title,volume,issue,page,type,published,published-print,article-number`, signal);
  const items = (d?.message?.items || []).map(normalizeWork).filter((w) => w.title);
  if (!items.length) return null;
  const scored = items.map((w) => ({ work: w, score: titleCoverage(w.title, ref) * (p.year && w.year && Math.abs(Number(p.year) - Number(w.year)) > 1 ? 0.85 : 1) }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0];
}

/** 查核整份清單（依序查詢，避免對 Crossref 造成負擔） */
export async function checkReferences(text, { signal, log = () => {}, delayMs = Number(process.env.REFCHECK_DELAY_MS ?? 120) } = {}) {
  const refs = splitReferences(extractReferenceSection(text));
  if (!refs.length) throw userError("沒有讀到任何文獻。請每行貼上一筆，或上傳含「參考文獻」章節的文件");
  if (refs.length > 200) throw userError(`共 ${refs.length} 筆，一次最多 200 筆，請分批查核`);
  log(`共 ${refs.length} 筆文獻，逐筆查核中…`);
  const results = [];
  for (const [i, r] of refs.entries()) {
    if (signal?.aborted) throw new Error("已取消");
    let res;
    try {
      res = await checkReference(r, { signal });
    } catch (e) {
      if (signal?.aborted || e.status === 502 || e.status === 429) throw e;
      res = { ref: r, status: "無法判斷", detail: `查詢失敗：${e.message}` };
    }
    results.push(res);
    if ((i + 1) % 5 === 0 || i === refs.length - 1) log(`已查核 ${i + 1}/${refs.length} 筆`);
    if (delayMs && i < refs.length - 1) await new Promise((ok) => setTimeout(ok, delayMs));
  }
  return results;
}

export const STATUS_ORDER = ["查無此文獻", "DOI 錯誤", "有差異", "無法判斷", "正確", "中文未查核"];

export function summarize(results) {
  const count = Object.fromEntries(STATUS_ORDER.map((s) => [s, results.filter((r) => r.status === s).length]));
  return count;
}

export function refcheckMarkdown(results, title = "參考文獻查核結果") {
  const c = summarize(results);
  const cell = (s) => String(s || "").replace(/\|/g, "／").replace(/\n/g, " ");
  const L = [
    `# ${title}`,
    "",
    `共 ${results.length} 筆：${STATUS_ORDER.filter((s) => c[s]).map((s) => `${s} ${c[s]} 筆`).join("、")}。`,
    "",
    "> 「查無此文獻」可能是捏造的文獻（AI 寫作常見）或書目資料錯誤；書籍、研討會論文與報告 Crossref 可能未收錄，請自行查證。",
    "",
    "| # | 結果 | 說明 | 原文獻 |",
    "|---|---|---|---|",
    ...results.map((r, i) => `| ${i + 1} | ${["正確", "中文未查核"].includes(r.status) ? r.status : `**${r.status}**`} | ${cell(r.detail)} | ${cell(r.ref)} |`),
  ];
  const fixable = results.filter((r) => r.apa && r.status !== "正確");
  if (fixable.length) L.push("", "## 依 Crossref 資料修正後（APA 第 7 版）", "", ...fixable.map((r) => `- 第 ${results.indexOf(r) + 1} 筆：${r.apa}`));
  return L.join("\n");
}

/** 修正後的完整清單：查到的用 APA，查不到的保留原文；中文在前、英文在後 */
export function correctedList(results) {
  const items = results.map((r) => (r.apa && r.status !== "查無此文獻" ? r.apa : ["查無此文獻", "DOI 錯誤"].includes(r.status) ? `【待查證】${r.ref}` : r.ref));
  const bare = (x) => x.replace(/^【待查證】/, "");
  const zh = items.filter((x) => isChinese(bare(x))).sort((a, b) => bare(a).localeCompare(bare(b), "zh-Hant-TW-u-co-stroke"));
  const en = items.filter((x) => !isChinese(bare(x))).sort((a, b) => bare(a).localeCompare(bare(b), "en", { sensitivity: "base" }));
  return [...zh, ...en];
}

export async function refcheckXlsx(results) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("查核結果");
  ws.columns = [
    { header: "#", key: "n", width: 5 },
    { header: "結果", key: "s", width: 12 },
    { header: "說明", key: "d", width: 50 },
    { header: "原文獻", key: "r", width: 70 },
    { header: "DOI", key: "doi", width: 28 },
    { header: "修正後（APA）", key: "apa", width: 70 },
  ];
  ws.getRow(1).font = { bold: true };
  const fill = { 查無此文獻: "FFF4CCCC", "DOI 錯誤": "FFF4CCCC", 有差異: "FFFFF0C2", 無法判斷: "FFFFF0C2" };
  results.forEach((r, i) => {
    const row = ws.addRow({ n: i + 1, s: r.status, d: r.detail, r: r.ref, doi: r.work?.doi || "", apa: r.apa || "" });
    if (fill[r.status]) row.getCell("s").fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill[r.status] } };
  });
  ws.columns.forEach((c) => (c.alignment = { wrapText: true, vertical: "top" }));
  ws.views = [{ state: "frozen", ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
