// 學術論文取得：期刊網站（ScienceDirect 等）會擋程式直接擷取，改走正規的學術 API
//  1. Elsevier Article Retrieval API（使用者自己的 API Key；機構網路或 Insttoken 下可取得全文）
//  2. Crossref（以 PII / DOI 找出論文資料，免金鑰）
//  3. OpenAlex（摘要與開放取用 PDF 連結，免金鑰）→ 若有 OA PDF 就下載解析
import { getSettings } from "./store.js";
import { parseDocument } from "./docs.js";

const BASE = {
  elsevier: process.env.SCHOLAR_ELSEVIER_BASE || "https://api.elsevier.com",
  crossref: process.env.SCHOLAR_CROSSREF_BASE || "https://api.crossref.org",
  openalex: process.env.SCHOLAR_OPENALEX_BASE || "https://api.openalex.org",
};
const UA = "AI-Studio/1.0 (scholarly metadata lookup)";

/** 從網址中辨識論文識別碼 */
export function identify(input) {
  const s = decodeURIComponent(String(input || "").trim());
  const doi = /\b(10\.\d{4,9}\/[^\s"<>?#]+)/i.exec(s)?.[1]?.replace(/[.,;)]+$/, "");
  const pii = /\/pii\/([A-Z0-9]{16,17})/i.exec(s)?.[1]?.toUpperCase() || (/^S[0-9X]{16}$/i.test(s) ? s.toUpperCase() : null);
  if (!doi && !pii) return null;
  return { doi: doi || null, pii: pii || null };
}

/** 是否為常見會擋爬蟲的學術出版網站 */
export function isScholarlySite(url) {
  try {
    const h = new URL(url).hostname;
    return /(sciencedirect|elsevier|springer|wiley|tandfonline|sagepub|ieeexplore|acm\.org|nature\.com|mdpi|cell\.com|oup\.com|cambridge\.org|doi\.org|researchgate)/i.test(h);
  } catch {
    return false;
  }
}

async function getJson(url, headers = {}, signal) {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json", ...headers }, signal });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const stripTags = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

function invertedToText(idx) {
  if (!idx) return "";
  const words = [];
  for (const [w, positions] of Object.entries(idx)) for (const p of positions) words[p] = w;
  return words.filter(Boolean).join(" ");
}

async function viaElsevier(id, log, signal) {
  const s = getSettings();
  if (!s.elsevierKey || (!id.pii && !id.doi)) return null;
  const path = id.pii ? `pii/${id.pii}` : `doi/${encodeURIComponent(id.doi)}`;
  log(`使用 Elsevier API 取得 ${id.pii || id.doi}`);
  const headers = { "X-ELS-APIKey": s.elsevierKey, ...(s.elsevierInstToken ? { "X-ELS-Insttoken": s.elsevierInstToken } : {}) };
  try {
    const data = await getJson(`${BASE.elsevier}/content/article/${path}?view=FULL`, headers, signal);
    const r = data["full-text-retrieval-response"] || {};
    const core = r.coredata || {};
    const full = typeof r.originalText === "string" ? r.originalText.trim() : "";
    const authors = [].concat(core["dc:creator"] || []).map((a) => a?.$ || a).filter((a) => typeof a === "string");
    return {
      source: "Elsevier API",
      fullText: full.length > 2000,
      title: core["dc:title"] || "",
      doi: core["prism:doi"] || id.doi,
      authors,
      journal: core["prism:publicationName"] || "",
      year: (core["prism:coverDate"] || "").slice(0, 4),
      abstract: stripTags(core["dc:description"]),
      text: full.length > 2000 ? full : "",
    };
  } catch (e) {
    if (e.status === 401 || e.status === 403) log(`Elsevier API 拒絕（${e.status}）：金鑰無效，或此網路／帳號沒有全文權限`);
    else log(`Elsevier API 失敗：${e.message}`);
    return null;
  }
}

async function resolveDoi(id, log, signal) {
  if (id.doi) return id.doi;
  if (!id.pii) return null;
  try {
    const d = await getJson(`${BASE.crossref}/works?filter=alternative-id:${id.pii}&rows=1`, {}, signal);
    const doi = d?.message?.items?.[0]?.DOI;
    if (doi) log(`Crossref：PII ${id.pii} → DOI ${doi}`);
    return doi || null;
  } catch (e) {
    log(`Crossref 查詢失敗：${e.message}`);
    return null;
  }
}

async function viaOpenAlex(doi, log, signal) {
  try {
    const w = await getJson(`${BASE.openalex}/works/doi:${encodeURIComponent(doi)}`, {}, signal);
    const pdfUrl = w.best_oa_location?.pdf_url || w.open_access?.oa_url || null;
    const meta = {
      source: "OpenAlex",
      title: w.title || w.display_name || "",
      doi,
      authors: (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean),
      journal: w.primary_location?.source?.display_name || "",
      year: String(w.publication_year || ""),
      abstract: invertedToText(w.abstract_inverted_index),
      isOa: !!w.open_access?.is_oa,
      oaUrl: pdfUrl,
      fullText: false,
      text: "",
    };
    if (pdfUrl) {
      log(`找到開放取用版本：${pdfUrl}`);
      try {
        const res = await fetch(pdfUrl, { headers: { "user-agent": UA }, redirect: "follow", signal });
        const type = res.headers.get("content-type") || "";
        if (res.ok && /pdf/i.test(type)) {
          const parsed = await parseDocument("paper.pdf", Buffer.from(await res.arrayBuffer()));
          meta.text = parsed.text;
          meta.fullText = true;
          meta.source = "OpenAlex（開放取用 PDF）";
        } else log(`開放取用連結不是 PDF 或無法下載（HTTP ${res.status}）`);
      } catch (e) {
        log(`下載開放取用 PDF 失敗：${e.message}`);
      }
    } else log("此論文沒有開放取用版本");
    return meta;
  } catch (e) {
    log(`OpenAlex 查詢失敗：${e.message}`);
    return null;
  }
}

/** 取得論文：回傳與 scrapePage 相同格式 { url, title, markdown, links, meta, scholar } */
export async function fetchPaper(url, { log = () => {}, signal } = {}) {
  const id = identify(url);
  if (!id) return null;
  let paper = await viaElsevier(id, log, signal);
  if (!paper?.fullText) {
    const doi = paper?.doi || (await resolveDoi(id, log, signal));
    if (doi) {
      const oa = await viaOpenAlex(doi, log, signal);
      if (oa && (oa.fullText || !paper)) paper = { ...oa, abstract: oa.abstract || paper?.abstract || "" };
    }
  }
  if (!paper || (!paper.text && !paper.abstract && !paper.title)) return null;

  const head = [
    `# ${paper.title || "（未取得標題）"}`,
    "",
    paper.authors?.length ? `- 作者：${paper.authors.join(", ")}` : "",
    paper.journal ? `- 期刊：${paper.journal}${paper.year ? `（${paper.year}）` : ""}` : "",
    paper.doi ? `- DOI：https://doi.org/${paper.doi}` : "",
    `- 來源：${paper.source}${paper.fullText ? "（全文）" : "（僅摘要）"}`,
  ].filter(Boolean);
  let body;
  if (paper.fullText) body = paper.text;
  else {
    body = `## Abstract\n\n${paper.abstract || "（未取得摘要）"}`;
    head.push(
      "",
      "> 只取得摘要，無法取得全文。若要處理全文：在設定頁填入 Elsevier API Key 並在學校／機構網路下執行，或從瀏覽器下載 PDF 後上傳到「檔案管理」，改用「讀取檔案」節點。",
    );
  }
  return {
    url,
    title: paper.title,
    markdown: head.join("\n") + "\n\n" + body,
    links: [],
    meta: { title: paper.title },
    scholar: { fullText: paper.fullText, source: paper.source, doi: paper.doi },
  };
}
