// 網頁工具：擷取網頁成 Markdown、整站爬取、網站健康檢測
import dns from "node:dns/promises";
import tls from "node:tls";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

const UA = "Mozilla/5.0 (compatible; AI-Studio/1.0; +local)";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
turndown.remove(["script", "style", "noscript", "iframe", "svg"]);
// 表格轉 Markdown 表格
turndown.addRule("table", {
  filter: "table",
  replacement(_c, node) {
    const rows = [...node.querySelectorAll("tr")].map((tr) =>
      [...tr.querySelectorAll("th,td")].map((td) => td.textContent.replace(/\s+/g, " ").replace(/\|/g, "/").trim()),
    );
    if (!rows.length) return "";
    const w = Math.max(...rows.map((r) => r.length));
    const line = (r) => "| " + Array.from({ length: w }, (_, i) => r[i] || "").join(" | ") + " |";
    return "\n\n" + [line(rows[0]), "|" + Array(w).fill("---").join("|") + "|", ...rows.slice(1).map(line)].join("\n") + "\n\n";
  },
});

export function htmlToMarkdown(html) {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return turndown.turndown(document.body).replace(/\n{3,}/g, "\n\n").trim();
}

export function normalizeUrl(u) {
  let s = String(u || "").trim();
  if (!s) throw Object.assign(new Error("請輸入網址"), { status: 400 });
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let url;
  try {
    url = new URL(s);
  } catch {
    throw Object.assign(new Error(`網址格式不正確：${String(u).slice(0, 100)}`), { status: 400 });
  }
  const h = url.hostname;
  const isIp = /^[\d.]+$/.test(h) || h.startsWith("[");
  if (/\s/.test(String(u).trim()) || !(isIp || h === "localhost" || /^[a-z0-9\u00a1-\uffff-]+(\.[a-z0-9\u00a1-\uffff-]+)+$/i.test(h))) {
    throw Object.assign(new Error(`網址格式不正確：${String(u).slice(0, 100)}`), { status: 400 });
  }
  url.hash = "";
  return url;
}

const NET_ERRORS = {
  ENOTFOUND: "找不到這個網站（網域名稱可能打錯，或目前沒有網路）",
  EAI_AGAIN: "暫時無法解析網域名稱，請檢查網路連線",
  ECONNREFUSED: "對方伺服器拒絕連線（網站可能關閉中）",
  ECONNRESET: "連線被對方中斷",
  CERT_HAS_EXPIRED: "網站的 SSL 憑證已過期",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "無法驗證網站的 SSL 憑證",
  DEPTH_ZERO_SELF_SIGNED_CERT: "網站使用自簽憑證，無法驗證",
};

async function fetchWithTimeout(url, { timeout = 15000, method = "GET", redirect = "follow", signal } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  const onAbort = () => ac.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    return await fetch(url, { method, redirect, signal: ac.signal, headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8" } });
  } catch (e) {
    if (ac.signal.aborted && !signal?.aborted) throw new Error(`連線逾時（${timeout / 1000} 秒）`);
    const code = e.cause?.code || "";
    throw new Error(`無法連線：${NET_ERRORS[code] || code || e.message}`);
  } finally {
    clearTimeout(t);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * 擷取單一網頁 → { url, title, markdown, links, meta }
 * mode: "article"（只取正文，Readability）或 "full"（整頁）
 */
const BLOCKED_HINT =
  "此網站拒絕程式直接存取（常見於需要登入、付費訂閱或有防爬蟲保護的網站）。可以：①在瀏覽器開啟後另存網頁或下載 PDF，上傳到「檔案管理」再用「讀取檔案」節點；②若網站有官方 API，改用「呼叫 API」節點。";

export async function scrapePage(input, { mode = "article", signal, log = () => {} } = {}) {
  const url = normalizeUrl(input);
  const { fetchPaper, identify, isScholarlySite } = await import("./scholar.js");
  // 學術論文網址：優先走學術 API（期刊網站通常會擋程式且全文需訂閱）
  if (isScholarlySite(url.href) && identify(url.href)) {
    log("偵測到學術論文網址，改用學術資料 API 取得");
    const paper = await fetchPaper(url.href, { log, signal });
    if (paper) return paper;
    log("學術 API 找不到此論文，改為直接擷取網頁");
  }
  const res = await fetchWithTimeout(url, { signal });
  if ([401, 403, 429, 451].includes(res.status)) {
    if (identify(url.href)) {
      const paper = await fetchPaper(url.href, { log, signal });
      if (paper) return paper;
    }
    throw new Error(`HTTP ${res.status}：${BLOCKED_HINT}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 404 ? "：找不到此網頁" : res.status >= 500 ? "：對方伺服器發生錯誤，請稍後再試" : ""}`);
  return readResponse(res, url, mode);
}

const DOC_TYPES = {
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "text/csv": ".csv",
};

/** 由回應判斷內容：網頁、文件檔（PDF/Word/Excel）、JSON 或純文字，並正確解碼各種編碼（Big5、GBK…） */
async function readResponse(res, url, mode) {
  const type = (res.headers.get("content-type") || "").toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());
  const finalUrl = res.url || url.href;
  const disposition = res.headers.get("content-disposition") || "";
  const nameFromHeader = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
  const fileName = decodeURIComponent(nameFromHeader || new URL(finalUrl).pathname.split("/").pop() || "");
  let ext = DOC_TYPES[type.split(";")[0].trim()] || (/\.(pdf|docx|xlsx|csv)$/i.exec(fileName)?.[0] ?? "");
  // 依檔頭判斷（有些網站會把 PDF 標成 application/octet-stream）
  if (!ext && buf.subarray(0, 5).toString("latin1") === "%PDF-") ext = ".pdf";
  if (ext) {
    const { parseDocument } = await import("./docs.js");
    const doc = await parseDocument(fileName.toLowerCase().endsWith(ext) ? fileName : `download${ext}`, buf);
    return { url: finalUrl, title: fileName || url.hostname, markdown: doc.text, links: [], meta: { title: fileName } };
  }
  if (/^(image|video|audio)\//.test(type) || /zip|octet-stream/.test(type)) {
    throw new Error(`此網址是二進位檔案（${type || "未知格式"}），不是網頁或可讀取的文件`);
  }
  const text = decodeBody(buf, type);
  if (/json/.test(type)) {
    try {
      return { url: finalUrl, title: url.pathname, markdown: "```json\n" + JSON.stringify(JSON.parse(text), null, 2).slice(0, 200000) + "\n```", links: [], meta: {} };
    } catch {
      /* 不是合法 JSON，當作文字 */
    }
  }
  if (!/html|xml/.test(type) && !/^\s*</.test(text)) {
    return { url: finalUrl, title: url.pathname, markdown: text.slice(0, 200000), links: [], meta: {} };
  }
  const page = parseHtmlPage(text, finalUrl, mode);
  if (page.markdown.replace(/[\s#*_>\-|`\[\]()!]/g, "").length < 30 && /<script/i.test(text)) {
    throw new Error("這個網頁的內容是由 JavaScript 動態產生的，程式無法直接讀取。可以在瀏覽器開啟後按 Ctrl+S 另存網頁（或複製文字），再到「文件處理」或「檔案管理」上傳。");
  }
  return page;
}

/** 依 HTTP 標頭或 <meta charset> 解碼 */
export function decodeBody(buf, contentType = "") {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = buf.subarray(0, 4096).toString("latin1");
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  charset = (charset || "utf-8").toLowerCase();
  if (charset === "big5-hkscs" || charset === "x-big5") charset = "big5";
  if (charset === "gb2312") charset = "gbk";
  try {
    return new TextDecoder(charset).decode(buf).replace(/^\uFEFF/, "");
  } catch {
    return buf.toString("utf8").replace(/^\uFEFF/, "");
  }
}

export function parseHtmlPage(html, pageUrl, mode = "article") {
  const { document } = parseHTML(html);
  const meta = {
    title: document.querySelector("title")?.textContent?.trim() || "",
    description: document.querySelector('meta[name="description"]')?.getAttribute("content") || "",
    ogTitle: document.querySelector('meta[property="og:title"]')?.getAttribute("content") || "",
    ogImage: document.querySelector('meta[property="og:image"]')?.getAttribute("content") || "",
    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href") || "",
    lang: document.documentElement?.getAttribute("lang") || "",
    viewport: !!document.querySelector('meta[name="viewport"]'),
    h1: [...document.querySelectorAll("h1")].map((h) => h.textContent.trim()).slice(0, 5),
    imagesWithoutAlt: [...document.querySelectorAll("img")].filter((i) => !i.getAttribute("alt")).length,
    images: document.querySelectorAll("img").length,
  };
  const links = [];
  for (const a of document.querySelectorAll("a[href]")) {
    try {
      const u = new URL(a.getAttribute("href"), pageUrl);
      if (!/^https?:$/.test(u.protocol)) continue;
      u.hash = "";
      links.push({ url: u.href, text: a.textContent.trim().slice(0, 80) });
    } catch {
      /* 忽略無效連結 */
    }
  }
  let title = meta.title;
  let contentHtml = document.body?.innerHTML || html;
  if (mode === "article") {
    try {
      const article = new Readability(document.cloneNode(true)).parse();
      if (article?.content && article.textContent.trim().length > 200) {
        contentHtml = article.content;
        title = article.title || title;
      }
    } catch {
      /* 解析失敗時使用整頁 */
    }
  }
  const markdown = htmlToMarkdown(contentHtml);
  return { url: pageUrl, title, markdown, links, meta };
}

/**
 * 同網域爬取（廣度優先）。
 * opts: { maxPages, maxDepth, include(正則字串), exclude(正則字串), delayMs, onPage(page), signal }
 */
export async function crawlSite(start, { maxPages = 20, maxDepth = 2, include = "", exclude = "", delayMs = 300, onPage = () => {}, signal } = {}) {
  const root = normalizeUrl(start);
  const inc = include ? new RegExp(include) : null;
  const exc = exclude ? new RegExp(exclude) : null;
  const seen = new Set([root.href]);
  const queue = [{ url: root.href, depth: 0 }];
  const pages = [];
  const errors = [];
  const skipExt = /\.(png|jpe?g|gif|webp|svg|ico|pdf|zip|gz|mp4|mp3|webm|css|js|woff2?|ttf|exe|dmg)$/i;
  while (queue.length && pages.length < maxPages) {
    if (signal?.aborted) throw new Error("已取消");
    const { url, depth } = queue.shift();
    try {
      const page = await scrapePage(url, { mode: "article", signal });
      page.depth = depth;
      pages.push(page);
      onPage(page, { done: pages.length, queued: queue.length });
      if (depth < maxDepth) {
        for (const l of page.links) {
          const u = new URL(l.url);
          if (u.host !== root.host || skipExt.test(u.pathname)) continue;
          u.search = u.search.length > 100 ? "" : u.search;
          if (seen.has(u.href)) continue;
          if (inc && !inc.test(u.href)) continue;
          if (exc && exc.test(u.href)) continue;
          seen.add(u.href);
          queue.push({ url: u.href, depth: depth + 1 });
        }
      }
    } catch (e) {
      errors.push({ url, error: e.message });
      onPage(null, { done: pages.length, queued: queue.length, error: `${url}：${e.message}` });
    }
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { pages, errors };
}

// ---------------- 網站檢測 ----------------

function certInfo(host, port = 443, timeout = 10000) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout }, () => {
      const c = sock.getPeerCertificate();
      const info = {
        authorized: sock.authorized,
        authError: sock.authorizationError ? String(sock.authorizationError) : null,
        protocol: sock.getProtocol(),
        subject: c?.subject?.CN,
        issuer: c?.issuer?.O || c?.issuer?.CN,
        validFrom: c?.valid_from,
        validTo: c?.valid_to,
        daysLeft: c?.valid_to ? Math.floor((new Date(c.valid_to) - Date.now()) / 86400000) : null,
        altNames: (c?.subjectaltname || "").split(", ").slice(0, 10),
      };
      sock.end();
      resolve(info);
    });
    sock.on("error", (e) => resolve({ error: e.code || e.message }));
    sock.on("timeout", () => {
      sock.destroy();
      resolve({ error: "逾時" });
    });
  });
}

async function dnsInfo(host) {
  const tryq = async (fn) => {
    try {
      return await fn();
    } catch {
      return [];
    }
  };
  const [a, aaaa, mx, ns, txt, cname] = await Promise.all([
    tryq(() => dns.resolve4(host)),
    tryq(() => dns.resolve6(host)),
    tryq(() => dns.resolveMx(host)),
    tryq(() => dns.resolveNs(host)),
    tryq(() => dns.resolveTxt(host)),
    tryq(() => dns.resolveCname(host)),
  ]);
  const flatTxt = txt.map((t) => t.join(""));
  return {
    A: a,
    AAAA: aaaa,
    CNAME: cname,
    MX: mx.sort((x, y) => x.priority - y.priority).map((m) => `${m.priority} ${m.exchange}`),
    NS: ns,
    TXT: flatTxt.slice(0, 15),
    spf: flatTxt.find((t) => t.startsWith("v=spf1")) || null,
  };
}

const SECURITY_HEADERS = {
  "strict-transport-security": "HSTS：強制瀏覽器使用 HTTPS",
  "content-security-policy": "CSP：限制可載入的腳本來源，防 XSS",
  "x-content-type-options": "防止 MIME 類型嗅探",
  "x-frame-options": "防止被嵌入 iframe（點擊劫持）",
  "referrer-policy": "控制 Referer 洩漏",
  "permissions-policy": "限制相機、麥克風等瀏覽器功能",
};

/**
 * 完整網站檢測。onStep(name, data) 每完成一項就回報。
 */
export async function checkSite(input, { onStep = () => {}, signal } = {}) {
  const url = normalizeUrl(input);
  const host = url.hostname;
  const report = { url: url.href, host, checkedAt: new Date().toISOString() };

  // 1. DNS
  report.dns = await dnsInfo(host);
  try {
    const dmarc = await dns.resolveTxt("_dmarc." + host.replace(/^www\./, ""));
    report.dns.dmarc = dmarc.map((t) => t.join("")).find((t) => t.startsWith("v=DMARC1")) || null;
  } catch {
    report.dns.dmarc = null;
  }
  onStep("dns", report.dns);

  // 2. 重新導向鏈與回應時間
  const chain = [];
  let cur = url.href;
  let res;
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) {
    const s = performance.now();
    res = await fetchWithTimeout(cur, { redirect: "manual", signal });
    chain.push({ url: cur, status: res.status, ms: Math.round(performance.now() - s) });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      cur = new URL(loc, cur).href;
      continue;
    }
    break;
  }
  const html = await res.text();
  const total = Math.round(performance.now() - t0);
  report.http = {
    finalUrl: cur,
    status: res.status,
    redirects: chain,
    totalMs: total,
    sizeKB: Math.round(Buffer.byteLength(html) / 102.4) / 10,
    server: res.headers.get("server"),
    poweredBy: res.headers.get("x-powered-by"),
    compression: res.headers.get("content-encoding"),
    cacheControl: res.headers.get("cache-control"),
    httpToHttps: url.protocol === "http:" ? cur.startsWith("https:") : null,
  };
  onStep("http", report.http);

  // 3. 安全標頭
  report.security = Object.entries(SECURITY_HEADERS).map(([h, desc]) => ({ header: h, desc, value: res.headers.get(h) }));
  const cookies = res.headers.getSetCookie?.() || [];
  report.cookies = cookies.map((c) => ({
    name: c.split("=")[0],
    secure: /;\s*secure/i.test(c),
    httpOnly: /;\s*httponly/i.test(c),
    sameSite: (/;\s*samesite=(\w+)/i.exec(c) || [])[1] || null,
  }));
  onStep("security", { headers: report.security, cookies: report.cookies });

  // 4. SSL 憑證
  const finalHost = new URL(cur).hostname;
  report.ssl = cur.startsWith("https:") || url.protocol === "https:" ? await certInfo(finalHost) : { error: "網站未使用 HTTPS" };
  onStep("ssl", report.ssl);

  // 5. SEO / 頁面資訊
  const page = parseHtmlPage(html, cur, "full");
  report.seo = { ...page.meta, wordCount: page.markdown.replace(/\s+/g, "").length, linkCount: page.links.length };
  onStep("seo", report.seo);

  // 6. robots.txt / sitemap
  const origin = new URL(cur).origin;
  const probe = async (p) => {
    try {
      const r = await fetchWithTimeout(origin + p, { timeout: 8000, signal });
      const body = r.ok ? (await r.text()).slice(0, 3000) : "";
      return { status: r.status, exists: r.ok && body.length > 0, preview: body.slice(0, 600) };
    } catch (e) {
      return { status: 0, exists: false, error: e.message };
    }
  };
  report.robots = await probe("/robots.txt");
  report.sitemap = await probe("/sitemap.xml");
  report.securityTxt = await probe("/.well-known/security.txt");
  onStep("files", { robots: report.robots, sitemap: report.sitemap, securityTxt: report.securityTxt });

  // 7. 失效連結（抽查同網域前 25 個）
  const internal = [...new Set(page.links.map((l) => l.url))].filter((u) => new URL(u).host === new URL(cur).host).slice(0, 25);
  const broken = [];
  await Promise.all(
    internal.map(async (u) => {
      try {
        let r = await fetchWithTimeout(u, { method: "HEAD", timeout: 8000, signal });
        if (r.status === 405 || r.status === 501) r = await fetchWithTimeout(u, { timeout: 8000, signal });
        if (r.status >= 400) broken.push({ url: u, status: r.status });
      } catch (e) {
        broken.push({ url: u, status: 0, error: e.message });
      }
    }),
  );
  report.links = { checked: internal.length, broken };
  onStep("links", report.links);

  report.score = scoreReport(report);
  onStep("score", report.score);
  return report;
}

/** 依檢測結果計分（0-100）並列出問題 */
export function scoreReport(r) {
  const issues = [];
  let score = 100;
  const hit = (pts, level, msg) => {
    score -= pts;
    issues.push({ level, msg });
  };
  if (r.http?.status >= 400) hit(30, "嚴重", `首頁回應 HTTP ${r.http.status}`);
  if (r.ssl?.error) hit(25, "嚴重", `SSL：${r.ssl.error}`);
  else {
    if (r.ssl && r.ssl.authorized === false) hit(20, "嚴重", `SSL 憑證不受信任：${r.ssl.authError}`);
    if (r.ssl?.daysLeft != null && r.ssl.daysLeft < 14) hit(15, "嚴重", `SSL 憑證將在 ${r.ssl.daysLeft} 天內到期`);
    else if (r.ssl?.daysLeft != null && r.ssl.daysLeft < 30) hit(5, "警告", `SSL 憑證將在 ${r.ssl.daysLeft} 天內到期`);
  }
  if (r.http?.httpToHttps === false) hit(10, "警告", "HTTP 沒有自動導向到 HTTPS");
  if (r.http?.totalMs > 3000) hit(10, "警告", `首頁載入較慢（${r.http.totalMs} ms）`);
  else if (r.http?.totalMs > 1500) hit(4, "提示", `首頁回應時間 ${r.http.totalMs} ms，可再優化`);
  if (!r.http?.compression) hit(3, "提示", "回應未啟用壓縮（gzip / br）");
  for (const h of r.security || []) if (!h.value) hit(h.header === "strict-transport-security" || h.header === "content-security-policy" ? 4 : 2, "提示", `缺少安全標頭 ${h.header}（${h.desc}）`);
  for (const c of r.cookies || []) if (!c.secure || !c.httpOnly) hit(2, "提示", `Cookie「${c.name}」缺少 ${[!c.secure && "Secure", !c.httpOnly && "HttpOnly"].filter(Boolean).join("、")}`);
  if (r.http?.poweredBy) hit(1, "提示", `回應標頭洩漏技術資訊：X-Powered-By: ${r.http.poweredBy}`);
  if (!r.seo?.title) hit(5, "警告", "頁面缺少 <title>");
  if (!r.seo?.description) hit(3, "提示", "缺少 meta description（影響搜尋結果摘要）");
  if (!r.seo?.viewport) hit(3, "警告", "缺少 viewport 設定（手機版顯示可能異常）");
  if (r.seo && r.seo.h1.length !== 1) hit(2, "提示", `頁面有 ${r.seo.h1.length} 個 <h1>（建議剛好 1 個）`);
  if (r.seo?.imagesWithoutAlt) hit(2, "提示", `${r.seo.imagesWithoutAlt} 張圖片缺少 alt 文字`);
  if (!r.robots?.exists) hit(1, "提示", "找不到 robots.txt");
  if (!r.sitemap?.exists) hit(1, "提示", "找不到 sitemap.xml");
  if (r.links?.broken?.length) hit(Math.min(15, r.links.broken.length * 3), "警告", `發現 ${r.links.broken.length} 個失效的站內連結`);
  if (!r.dns?.spf && r.dns?.MX?.length) hit(2, "提示", "有郵件伺服器（MX）但沒有 SPF 記錄，郵件易被冒用");
  return { score: Math.max(0, score), grade: score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F", issues };
}

export function reportToMarkdown(r) {
  const lines = [`# 網站檢測報告：${r.host}`, "", `- 檢測時間：${r.checkedAt}`, `- 總分：**${r.score.score} / 100（${r.score.grade}）**`, ""];
  lines.push("## 發現的問題", "");
  if (!r.score.issues.length) lines.push("沒有發現問題 ");
  for (const i of r.score.issues) lines.push(`- 【${i.level}】${i.msg}`);
  lines.push("", "## 連線", "", `- 最終網址：${r.http.finalUrl}（HTTP ${r.http.status}）`, `- 總耗時：${r.http.totalMs} ms，大小 ${r.http.sizeKB} KB，壓縮：${r.http.compression || "無"}`, `- 伺服器：${r.http.server || "-"}`);
  if (r.http.redirects.length > 1) lines.push(`- 重新導向：${r.http.redirects.map((x) => `${x.status} ${x.url}`).join(" → ")}`);
  lines.push("", "## SSL 憑證", "");
  if (r.ssl.error) lines.push(`- ${r.ssl.error}`);
  else lines.push(`- 簽發者：${r.ssl.issuer}`, `- 有效期限：${r.ssl.validTo}（剩 ${r.ssl.daysLeft} 天）`, `- 協定：${r.ssl.protocol}`, `- 受信任：${r.ssl.authorized ? "是" : "否 " + (r.ssl.authError || "")}`);
  lines.push("", "## 安全標頭", "", "| 標頭 | 狀態 | 說明 |", "|---|---|---|");
  for (const h of r.security) lines.push(`| ${h.header} | ${h.value ? "" : "缺少"} | ${h.desc} |`);
  lines.push("", "## DNS", "");
  for (const k of ["A", "AAAA", "CNAME", "MX", "NS"]) if (r.dns[k]?.length) lines.push(`- ${k}：${r.dns[k].join("、")}`);
  lines.push(`- SPF：${r.dns.spf || "無"}`, `- DMARC：${r.dns.dmarc || "無"}`);
  lines.push("", "## SEO", "", `- 標題：${r.seo.title || "（無）"}`, `- 描述：${r.seo.description || "（無）"}`, `- H1：${r.seo.h1.join("、") || "（無）"}`, `- 語言：${r.seo.lang || "未設定"}`, `- robots.txt：${r.robots.exists ? "有" : "無"}；sitemap.xml：${r.sitemap.exists ? "有" : "無"}`);
  lines.push("", "## 站內連結", "", `- 抽查 ${r.links.checked} 個，失效 ${r.links.broken.length} 個`);
  for (const b of r.links.broken) lines.push(`  - ${b.status || "錯誤"} ${b.url}`);
  return lines.join("\n");
}
