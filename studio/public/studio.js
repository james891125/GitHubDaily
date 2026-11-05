// AI 工作坊 —— 前端
import { miniMarkdown } from "./mini-md.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const md = (t) => miniMarkdown(t || "");
let META = null;

function toast(msg, ms = 2800) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add("hidden"), ms);
}

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const post = (path, data) => api(path, { method: "POST", body: JSON.stringify(data) });
const del = (path) => api(path, { method: "DELETE" });

/** NDJSON 串流 */
async function streamPost(path, data, onEvent, signal) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data), signal });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let err = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const ev = JSON.parse(line);
      if (ev.type === "error") err = ev.message;
      else onEvent(ev);
    }
  }
  if (err) throw new Error(err);
}

/** 節流渲染串流文字 */
function liveMarkdown(el) {
  let text = "";
  let pending = false;
  return {
    add(d) {
      text += d;
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        el.innerHTML = md(text);
        el.scrollTop = el.scrollHeight;
        pending = false;
      });
    },
    set(t) {
      text = t;
      el.innerHTML = md(t);
    },
    get text() {
      return text;
    },
  };
}

/** 顯示一次任務的 AI 用量 */
function usageText(u) {
  if (!u || (!u.calls && !u.cached)) return "未使用 AI";
  const tokens = (u.inputTokens + u.outputTokens).toLocaleString();
  return `AI 呼叫 ${u.calls} 次${u.cached ? `（另有 ${u.cached} 次使用快取，未計費）` : ""} · ${u.estimated ? "約 " : ""}${tokens} tokens（輸入 ${u.inputTokens.toLocaleString()} / 輸出 ${u.outputTokens.toLocaleString()}）`;
}

const fileLinks = (files = []) => files.map((f) => `<a href="${esc(f.url)}" download="${esc(f.name.replace(/^\d+_/, ""))}">⬇️ ${esc(f.name.replace(/^\d+_/, ""))}</a>`).join("");
const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : n > 1024 ? Math.round(n / 1024) + " KB" : n + " B");
const fmtTime = (s) => (s ? new Date(s).toLocaleString("zh-TW", { hour12: false }) : "");

function readFileB64(file) {
  return new Promise((resolve, reject) => {
    if (file.size > 30 * 1024 * 1024) return reject(new Error("檔案超過 30 MB"));
    const r = new FileReader();
    r.onload = () => resolve({ name: file.name, data: String(r.result).split(",")[1] });
    r.onerror = () => reject(new Error("讀取檔案失敗"));
    r.readAsDataURL(file);
  });
}

// ---------------- 分頁 ----------------
const tabHooks = {};
function showTab(name) {
  if (!$("#tab-" + name)) name = "home";
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
  history.replaceState(null, "", "#" + name);
  tabHooks[name]?.();
}
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (b) showTab(b.dataset.tab);
});
document.addEventListener("click", (e) => {
  const g = e.target.closest("[data-goto]");
  if (g) {
    e.preventDefault();
    showTab(g.dataset.goto);
  }
});

function segment(segEl, attr, paneAttr, onChange) {
  segEl.addEventListener("click", (e) => {
    const b = e.target.closest(`[data-${attr}]`);
    if (!b) return;
    $$(`[data-${attr}]`, segEl).forEach((x) => x.classList.toggle("on", x === b));
    const v = b.dataset[attr];
    $$(`[data-${paneAttr}]`).forEach((p) => p.classList.toggle("hidden", p.dataset[paneAttr.replace(/-(\w)/g, (_, c) => c.toUpperCase())] !== v));
    onChange?.(v);
  });
  return () => $(`[data-${attr}].on`, segEl)?.dataset[attr];
}

// ---------------- 首頁 ----------------
tabHooks.home = async () => {
  const [runs, outs] = await Promise.all([api("/api/runs"), api("/api/outputs")]);
  $("#home-runs").innerHTML = runs.length
    ? runs.slice(0, 8).map((r) => `<div class="item"><span class="grow">${esc(r.flowName)} <span class="hint">${r.trigger === "schedule" ? "⏰ 排程" : ""} ${fmtTime(r.startedAt)}</span></span>${r.usage?.calls ? `<span class="hint">AI ${r.usage.calls} 次</span>` : ""}<span class="status ${r.status}">${{ success: "成功", error: "失敗", stopped: "條件停止", running: "執行中" }[r.status]}</span></div>`).join("")
    : `<p class="hint">還沒有執行紀錄。</p>`;
  $("#home-outputs").innerHTML = outs.length ? outs.slice(0, 8).map(outputItem).join("") : `<p class="hint">還沒有產出檔案。</p>`;
};
const outputItem = (f) => `<div class="item"><a class="grow" href="${esc(f.url)}" download="${esc(f.name.replace(/^\d+_/, ""))}">${esc(f.name.replace(/^\d+_/, ""))}</a><span class="hint">${fmtSize(f.size)} · ${fmtTime(f.at)}</span></div>`;

// ---------------- 設定 ----------------
let settingsDirty = false; // 使用者正在編輯時，不要被稍後才回來的資料覆蓋
async function loadSettings() {
  const s = await api("/api/settings");
  if (settingsDirty) return loadUsage();
  $("#s-cmodel").innerHTML = META.models.map((m) => `<option value="${m.id}">${esc(m.label)}</option>`).join("");
  $("#s-provider").value = s.provider;
  $("#s-akey").value = s.anthropicKey;
  $("#s-cmodel").value = s.claudeModel;
  $("#s-effort").value = s.effort || "";
  $("#s-okey").value = s.openaiKey;
  $("#s-obase").value = s.openaiBase;
  $("#s-omodel").value = s.openaiModel;
  $("#s-webhook").value = s.webhookUrl;
  $("#s-elskey").value = s.elsevierKey;
  $("#s-elstoken").value = s.elsevierInstToken;
  $("#s-mode").value = s.usageMode || "economy";
  $("#s-cache").value = String(s.cacheDays ?? 7);
  toggleProvider();
  loadUsage();
}
function toggleProvider() {
  const oa = $("#s-provider").value === "openai";
  $("#s-claude").classList.toggle("hidden", oa);
  $("#s-openai").classList.toggle("hidden", !oa);
}
function setReady(ready) {
  META.ready = ready;
  $("#key-dot").classList.toggle("on", ready);
  $("#setup-banner").classList.toggle("hidden", ready);
}
$("#s-provider").addEventListener("change", toggleProvider);
$("#tab-settings").addEventListener("input", (e) => {
  if (e.target.matches("input, select")) settingsDirty = true;
});
async function loadUsage() {
  const u = await api("/api/usage");
  const box = (title, x) => `<div>${title}<b>${x.calls.toLocaleString()} 次</b><span class="usage-note">${(x.inputTokens + x.outputTokens).toLocaleString()} tokens · 快取省下 ${x.cached} 次</span></div>`;
  $("#usage-box").innerHTML = box("今天", u.today) + box("本月", u.month);
}
$("#s-clear-cache").addEventListener("click", async () => {
  const r = await post("/api/cache/clear", {});
  toast(`已清除 ${r.removed} 筆快取`);
});
async function saveSettingsForm() {
  const r = await post("/api/settings", {
    provider: $("#s-provider").value,
    anthropicKey: $("#s-akey").value.trim(),
    claudeModel: $("#s-cmodel").value,
    effort: $("#s-effort").value,
    openaiKey: $("#s-okey").value.trim(),
    openaiBase: $("#s-obase").value.trim(),
    openaiModel: $("#s-omodel").value.trim(),
    webhookUrl: $("#s-webhook").value.trim(),
    elsevierKey: $("#s-elskey").value.trim(),
    elsevierInstToken: $("#s-elstoken").value.trim(),
    usageMode: $("#s-mode").value,
    cacheDays: Number($("#s-cache").value),
  });
  setReady(r.ready);
  settingsDirty = false;
  $("#s-akey").value = r.anthropicKey;
  $("#s-okey").value = r.openaiKey;
  $("#s-elskey").value = r.elsevierKey;
  $("#s-elstoken").value = r.elsevierInstToken;
}
$("#s-save").addEventListener("click", async () => {
  await saveSettingsForm();
  $("#s-status").textContent = "✅ 已儲存";
});
$("#s-test").addEventListener("click", async () => {
  await saveSettingsForm();
  $("#s-status").textContent = "測試中…";
  const r = await post("/api/settings/test", {});
  $("#s-status").textContent = r.ok ? `✅ ${r.text}（${r.model}）` : `❌ ${r.error}`;
});
tabHooks.settings = loadSettings;

function needKey() {
  if (META.ready) return false;
  toast("這個功能需要 AI，請先在「設定」輸入 API Key");
  showTab("settings");
  return true;
}

// ---------------- 檔案 ----------------
let FILES = [];
async function refreshFiles() {
  FILES = await api("/api/files");
  return FILES;
}
tabHooks.files = async () => {
  await refreshFiles();
  $("#lib-list").innerHTML = FILES.length
    ? FILES.map((f) => `<div class="item"><span class="grow">${esc(f.name)} <span class="hint">${f.chars.toLocaleString()} 字${f.pages ? ` · ${f.pages} 頁` : ""}</span></span><button class="small" data-del-file="${f.id}">刪除</button></div>`).join("")
    : `<p class="hint">尚無檔案。</p>`;
  const outs = await api("/api/outputs");
  $("#out-list").innerHTML = outs.length ? outs.map(outputItem).join("") : `<p class="hint">尚無產出檔案。</p>`;
};
$("#lib-upload").addEventListener("change", async (e) => {
  for (const file of e.target.files) {
    try {
      toast(`上傳並解析 ${file.name}…`);
      await post("/api/files", await readFileB64(file));
    } catch (err) {
      toast(`${file.name}：${err.message}`, 5000);
    }
  }
  e.target.value = "";
  tabHooks.files();
});
$("#lib-list").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-del-file]");
  if (b && confirm("刪除此檔案？")) {
    await del("/api/files?id=" + b.dataset.delFile);
    tabHooks.files();
  }
});

// ---------------- 文件工具 ----------------
const docSrc = segment($("#doc-src-seg"), "src", "src-pane");
const docTool = segment($("#doc-tool-seg"), "tool", "tool-pane");
tabHooks.docs = async () => {
  await refreshFiles();
  $("#doc-lib").innerHTML = FILES.length ? FILES.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join("") : `<option value="">（檔案庫是空的）</option>`;
};
let docAbort = null;
$("#doc-stop").addEventListener("click", () => docAbort?.abort());
$("#doc-run").addEventListener("click", async () => {
  const tool = docTool() || "convert";
  if (tool !== "convert" && needKey()) return;
  const src = docSrc() || "upload";
  const payload = {};
  try {
    if (src === "upload") {
      const f = $("#doc-file").files[0];
      if (!f) return toast("請選擇檔案");
      $("#doc-status").textContent = "上傳並解析中…";
      const saved = await post("/api/files", await readFileB64(f));
      payload.fileId = saved.id;
    } else if (src === "library") payload.fileId = $("#doc-lib").value;
    else if (src === "url") payload.url = $("#doc-url").value.trim();
    else payload.text = $("#doc-text").value;
    if (!payload.fileId && !payload.url && !payload.text) return toast("請提供要處理的內容");
  } catch (e) {
    $("#doc-status").textContent = "❌ " + e.message;
    return;
  }
  const out = $("#doc-output");
  const live = liveMarkdown(out);
  live.set("");
  $("#doc-files").innerHTML = "";
  const bar = $("#doc-progress");
  bar.classList.add("hidden");
  $("#doc-run").disabled = true;
  $("#doc-stop").classList.remove("hidden");
  $("#doc-status").textContent = "處理中…";
  docAbort = new AbortController();
  const t0 = Date.now();
  let docUsage = null;
  try {
    if (tool === "convert") {
      const r = await post("/api/doc/convert", payload);
      live.set(r.text.length > 60000 ? r.text.slice(0, 60000) + "\n\n…（預覽已截斷，完整內容請下載）" : r.text);
      $("#doc-files").innerHTML = fileLinks(r.files);
    } else {
      Object.assign(payload, {
        translate: { target: $("#doc-lang").value, glossary: $("#doc-glossary").value },
        summarize: { style: $("#doc-style").value, length: $("#doc-length").value },
        extract: { fields: $("#doc-fields").value, instruction: $("#doc-instr").value },
      }[tool]);
      await streamPost(
        `/api/doc/${tool}`,
        payload,
        (ev) => {
          if (ev.type === "text") live.add(ev.delta);
          else if (ev.type === "log") $("#doc-status").textContent = ev.message;
          else if (ev.type === "progress") {
            bar.classList.remove("hidden");
            $("div", bar).style.width = `${Math.round((ev.done / ev.total) * 100)}%`;
            $("#doc-status").textContent = `進度 ${ev.done}/${ev.total}`;
          } else if (ev.type === "usage") {
            docUsage = ev.usage;
          } else if (ev.type === "done") {
            if (ev.table) live.set(`共擷取 **${ev.table.rows.length}** 筆資料\n\n` + tableMd(ev.table));
            else if (ev.output) live.set(ev.output);
            $("#doc-files").innerHTML = fileLinks(ev.files);
          }
        },
        docAbort.signal,
      );
    }
    $("#doc-status").textContent = `✅ 完成（${((Date.now() - t0) / 1000).toFixed(1)} 秒）· ${usageText(docUsage)}`;
  } catch (e) {
    $("#doc-status").textContent = e.name === "AbortError" ? "已停止" : "❌ " + e.message;
  } finally {
    $("#doc-run").disabled = false;
    $("#doc-stop").classList.add("hidden");
    docAbort = null;
  }
});
function tableMd({ columns, rows }) {
  const c = (s) => String(s ?? "").replace(/\|/g, "/").replace(/\n/g, " ");
  return [`| ${columns.map(c).join(" | ")} |`, `|${columns.map(() => "---").join("|")}|`, ...rows.slice(0, 300).map((r) => `| ${columns.map((k) => c(r[k])).join(" | ")} |`)].join("\n");
}

// ---------------- 網站工具 ----------------
const webMode = segment($("#web-seg"), "web", "web-pane", () => ($("#web-result").innerHTML = ""));
let webAbort = null;
tabHooks.web = async () => {
  const kbs = await api("/api/kb");
  $("#crawl-kb").innerHTML = `<option value="">（不存）</option>` + kbs.map((k) => `<option value="${k.id}">${esc(k.name)}</option>`).join("");
};
$("#web-stop").addEventListener("click", () => webAbort?.abort());
$("#web-url").addEventListener("keydown", (e) => e.key === "Enter" && $("#web-run").click());
$("#web-run").addEventListener("click", async () => {
  const url = $("#web-url").value.trim();
  if (!url) return toast("請輸入網址");
  const mode = webMode() || "check";
  const out = $("#web-result");
  out.innerHTML = "";
  $("#web-run").disabled = true;
  $("#web-stop").classList.remove("hidden");
  $("#web-status").textContent = "執行中…";
  webAbort = new AbortController();
  try {
    if (mode === "check") await runCheck(url, out);
    else if (mode === "scrape") {
      const r = await post("/api/web/scrape", { url, mode: $("#web-mode").value });
      out.innerHTML = `<div class="files">${fileLinks(r.files)}</div><h2>${esc(r.title)}</h2><p class="hint">${r.markdown.length.toLocaleString()} 字 · ${r.links.length} 個連結</p><div class="markdown output">${md(r.markdown.slice(0, 80000))}</div>`;
    } else {
      out.innerHTML = `<div class="pages list" id="crawl-pages"></div><div id="crawl-done"></div>`;
      await streamPost(
        "/api/web/crawl",
        { url, maxPages: $("#crawl-max").value, maxDepth: $("#crawl-depth").value, include: $("#crawl-inc").value, kbId: $("#crawl-kb").value },
        (ev) => {
          if (ev.type === "page") {
            $("#crawl-pages").insertAdjacentHTML("beforeend", `<div class="item"><span class="grow">${esc(ev.title || ev.url)}<br/><a class="hint" href="${esc(ev.url)}" target="_blank" rel="noopener">${esc(ev.url)}</a></span><span class="hint">${ev.chars.toLocaleString()} 字</span></div>`);
            $("#web-status").textContent = `已爬取 ${ev.done} 頁，佇列中 ${ev.queued} 頁`;
          } else if (ev.type === "log") $("#crawl-pages").insertAdjacentHTML("beforeend", `<div class="item hint">✗ ${esc(ev.message)}</div>`);
          else if (ev.type === "done")
            $("#crawl-done").innerHTML = `<p>✅ 共 ${ev.pages} 頁${ev.errors.length ? `，${ev.errors.length} 頁失敗` : ""}${ev.kbResult ? `，已存入知識庫 ${ev.kbResult.added} 份文件` : ""}</p><div class="files">${fileLinks(ev.files)}</div>`;
        },
        webAbort.signal,
      );
    }
    $("#web-status").textContent = "✅ 完成";
  } catch (e) {
    $("#web-status").textContent = e.name === "AbortError" ? "已停止" : "❌ " + e.message;
  } finally {
    $("#web-run").disabled = false;
    $("#web-stop").classList.add("hidden");
  }
});

const kv = (obj) => `<dl class="kv">${Object.entries(obj).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(Array.isArray(v) ? v.join("、") || "-" : v ?? "-")}</dd>`).join("")}</dl>`;
async function runCheck(url, out) {
  out.innerHTML = `<div id="ck-score"></div><div class="checks" id="ck-grid"></div><div id="ck-ai"></div>`;
  const grid = $("#ck-grid");
  const card = (title, html) => grid.insertAdjacentHTML("beforeend", `<div class="panel"><h4>${title}</h4>${html}</div>`);
  const names = { dns: "DNS", http: "連線", security: "安全標頭", ssl: "SSL 憑證", seo: "SEO", files: "robots / sitemap", links: "失效連結" };
  let final;
  await streamPost(
    "/api/web/check",
    { url },
    (ev) => {
      if (ev.type === "step") {
        $("#web-status").textContent = `檢查 ${names[ev.step] || ev.step}…`;
        const d = ev.data;
        if (ev.step === "dns") card("🌍 DNS", kv({ A: d.A, AAAA: d.AAAA, MX: d.MX, NS: d.NS, SPF: d.spf || "無", DMARC: d.dmarc || "無" }));
        if (ev.step === "http") card("⚡ 連線", kv({ 狀態: d.status, 總耗時: d.totalMs + " ms", 大小: d.sizeKB + " KB", 壓縮: d.compression || "無", 伺服器: d.server, 重新導向: d.redirects.map((r) => `${r.status}`).join(" → ") }));
        if (ev.step === "security") card("🛡️ 安全標頭", d.headers.map((h) => `<div>${h.value ? "✅" : "❌"} <code>${esc(h.header)}</code> <span class="hint">${esc(h.desc)}</span></div>`).join(""));
        if (ev.step === "ssl") card("🔒 SSL 憑證", d.error ? `<p class="lv-嚴重">${esc(d.error)}</p>` : kv({ 簽發者: d.issuer, 到期: d.validTo, 剩餘天數: d.daysLeft, 協定: d.protocol, 受信任: d.authorized ? "是" : "否 " + (d.authError || "") }));
        if (ev.step === "seo") card("🔍 SEO", kv({ 標題: d.title, 描述: d.description, H1: d.h1, 語言: d.lang || "未設定", "缺 alt 圖片": `${d.imagesWithoutAlt}/${d.images}`, 手機版viewport: d.viewport ? "有" : "無" }));
        if (ev.step === "files") card("📄 robots / sitemap", kv({ "robots.txt": d.robots.exists ? "有" : "無", "sitemap.xml": d.sitemap.exists ? "有" : "無", "security.txt": d.securityTxt.exists ? "有" : "無" }));
        if (ev.step === "links") card("🔗 站內連結", `<p>抽查 ${d.checked} 個，失效 ${d.broken.length} 個</p>${d.broken.map((b) => `<div class="hint">${b.status || "錯誤"} ${esc(b.url)}</div>`).join("")}`);
      } else if (ev.type === "done") final = ev;
    },
    webAbort.signal,
  );
  const s = final.report.score;
  $("#ck-score").innerHTML = `<div class="score"><span class="big">${s.score}</span><span class="grade grade-${s.grade}">${s.grade}</span><div class="files">${fileLinks(final.files)}<button id="ck-advise">🤖 AI 修正建議</button></div></div>
    <ul class="issues">${s.issues.map((i) => `<li><span class="lv-${i.level}">【${i.level}】</span>${esc(i.msg)}</li>`).join("") || "<li>沒有發現問題 🎉</li>"}</ul>`;
  $("#ck-advise").addEventListener("click", async () => {
    if (needKey()) return;
    const box = $("#ck-ai");
    box.innerHTML = `<div class="markdown output"></div>`;
    const live = liveMarkdown($(".markdown", box));
    $("#ck-advise").disabled = true;
    try {
      await streamPost("/api/web/advise", { markdown: final.markdown }, (ev) => ev.type === "text" && live.add(ev.delta));
    } catch (e) {
      live.set("❌ " + e.message);
    }
    $("#ck-advise").disabled = false;
  });
}

// ---------------- 知識庫 ----------------
let currentKb = null;
let kbAddOpen = false; // 加入文件後，「文件」區塊維持展開，方便連續加入
const chatHistory = {};
async function renderKbList() {
  const kbs = await api("/api/kb");
  $("#kb-list").innerHTML = kbs.length
    ? kbs.map((k) => `<button class="wf-item ${currentKb === k.id ? "active" : ""}" data-kb="${k.id}">${esc(k.name)}<small>${k.docs} 份文件 · ${k.chunks} 段</small></button>`).join("")
    : `<p class="hint">尚無知識庫。</p>`;
  return kbs;
}
tabHooks.kb = async () => {
  const kbs = await renderKbList();
  if (!currentKb && kbs.length) openKb(kbs[0].id);
};
$("#kb-list").addEventListener("click", (e) => {
  const b = e.target.closest("[data-kb]");
  if (b) openKb(b.dataset.kb);
});
$("#kb-new").addEventListener("click", async () => {
  const name = $("#kb-new-name").value.trim();
  if (!name) return toast("請輸入名稱");
  const k = await post("/api/kb", { name });
  $("#kb-new-name").value = "";
  openKb(k.id);
});

async function openKb(id) {
  if (currentKb !== id) kbAddOpen = false;
  currentKb = id;
  await renderKbList();
  const k = await api("/api/kb/detail?id=" + id);
  chatHistory[id] ||= [];
  $("#kb-panel").innerHTML = `
    <div class="row" style="justify-content:space-between"><h2 style="margin:0">📚 ${esc(k.name)}</h2><button class="small" id="kb-del">刪除知識庫</button></div>
    <details id="kb-docs-box" ${!k.docs.length || kbAddOpen ? "open" : ""}><summary><b>文件（${k.docs.length}）</b>　<span class="hint">共 ${k.chunks} 個段落</span></summary>
      <div class="list kb-docs">${k.docs.map((d) => `<div class="item"><span class="grow">${esc(d.title)} <span class="hint">${d.chars.toLocaleString()} 字 · ${d.chunks} 段${d.source ? ` · ${esc(d.source)}` : ""}</span></span><button class="small" data-del-doc="${d.id}">移除</button></div>`).join("") || `<p class="hint">還沒有文件，請從下方加入。</p>`}</div>
      <div class="row">
        <input type="file" id="kb-file" multiple style="flex:1" />
        <button id="kb-add-file">加入檔案</button>
      </div>
      <div class="row"><input id="kb-url" placeholder="或輸入網址（單頁）" style="flex:1" /><button id="kb-add-url">加入網頁</button><button data-goto="web" title="到網站工具爬取整站並存入此知識庫">🕷️ 爬整站…</button></div>
      <div class="row"><textarea id="kb-text" rows="2" placeholder="或直接貼上文字" style="flex:1"></textarea><button id="kb-add-text">加入文字</button></div>
      <span id="kb-status" class="hint"></span>
    </details>
    <div class="chat" id="kb-chat"></div>
    <div class="chat-input"><textarea id="kb-q" rows="2" placeholder="輸入問題，Enter 送出（Shift+Enter 換行）"></textarea><button id="kb-ask" class="primary">送出</button></div>
    <div class="row"><button class="small" id="kb-clear-chat">清除對話</button><span class="hint">AI 只根據知識庫內容回答，並以 [1] [2] 標示出處，點出處可看原文。</span></div>`;
  renderChat();
  const status = (m) => ($("#kb-status").textContent = m);
  $("#kb-del").onclick = async () => {
    if (!confirm(`刪除知識庫「${k.name}」？`)) return;
    await del("/api/kb?id=" + id);
    currentKb = null;
    $("#kb-panel").innerHTML = `<p class="hint">已刪除。</p>`;
    renderKbList();
  };
  $("#kb-panel").querySelectorAll("[data-del-doc]").forEach((b) =>
    b.addEventListener("click", async () => {
      await del(`/api/kb/docs?kbId=${id}&docId=${b.dataset.delDoc}`);
      openKb(id);
    }),
  );
  const add = async (payload, label) => {
    status(`加入 ${label}…`);
    try {
      kbAddOpen = true;
    const r = await post("/api/kb/docs", { kbId: id, ...payload });
      status(`✅ ${label}：切成 ${r.chunks} 段`);
      return true;
    } catch (e) {
      status(`❌ ${label}：${e.message}`);
      return false;
    }
  };
  $("#kb-add-file").onclick = async () => {
    const files = [...$("#kb-file").files];
    if (!files.length) return toast("請選擇檔案");
    let ok = 0;
    for (const f of files) {
      try {
        if (await add({ file: await readFileB64(f) }, f.name)) ok++;
      } catch (e) {
        status(`❌ ${f.name}：${e.message}`);
      }
    }
    if (ok) openKb(id);
  };
  $("#kb-add-url").onclick = async () => {
    const url = $("#kb-url").value.trim();
    if (url && (await add({ url }, url))) openKb(id);
  };
  $("#kb-add-text").onclick = async () => {
    const text = $("#kb-text").value.trim();
    if (text && (await add({ text, title: text.slice(0, 30) }, "文字"))) openKb(id);
  };
  $("#kb-ask").onclick = () => askKb(id);
  $("#kb-q").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      askKb(id);
    }
  });
  $("#kb-clear-chat").onclick = () => {
    chatHistory[id] = [];
    renderChat();
  };
}

function msgHtml(m) {
  if (m.role === "user") return `<div class="msg user">${esc(m.content)}</div>`;
  const src = (m.sources || [])
    .map((s) => `<details><summary>[${s.n}] ${esc(s.title)}${s.heading ? " ／ " + esc(s.heading) : ""}</summary><pre>${esc(s.text)}</pre></details>`)
    .join("");
  return `<div class="msg ai"><div class="markdown">${md(m.content)}</div>${src ? `<div class="src"><b>出處</b>${src}</div>` : ""}${m.usage ? `<div class="usage-note">${esc(usageText(m.usage))}</div>` : ""}</div>`;
}
function renderChat() {
  const box = $("#kb-chat");
  if (!box) return;
  const h = chatHistory[currentKb] || [];
  box.innerHTML = h.length ? h.map(msgHtml).join("") : `<p class="hint">試著問：「這份文件的重點是什麼？」或「退貨期限是幾天？」</p>`;
}
async function askKb(id) {
  const q = $("#kb-q").value.trim();
  if (!q || needKey()) return;
  const h = chatHistory[id];
  const history = h.map(({ role, content }) => ({ role, content }));
  h.push({ role: "user", content: q });
  $("#kb-q").value = "";
  renderChat();
  const box = $("#kb-chat");
  box.insertAdjacentHTML("beforeend", `<div class="msg ai"><div class="markdown">思考中…</div></div>`);
  const live = liveMarkdown($(".msg.ai:last-child .markdown", box));
  $("#kb-ask").disabled = true;
  try {
    await streamPost("/api/kb/ask", { kbId: id, question: q, history }, (ev) => {
      if (ev.type === "text") live.add(ev.delta);
      if (ev.type === "done") h.push({ role: "assistant", content: ev.answer, sources: ev.sources });
      if (ev.type === "usage" && h.at(-1)?.role === "assistant") h.at(-1).usage = ev.usage;
    });
  } catch (e) {
    h.push({ role: "assistant", content: "❌ " + e.message });
  }
  $("#kb-ask").disabled = false;
  renderChat();
  box.lastElementChild?.scrollIntoView({ block: "nearest" });
}

// ---------------- 工作流 ----------------
let FLOWS = [];
let editing = null; // 正在編輯的工作流（物件副本）
let flowAbort = null;
let KBS = [];
let addMenuOpen = false; // 「新增節點」選單在重新繪製後維持展開

tabHooks.flows = async () => {
  [FLOWS, KBS] = await Promise.all([api("/api/flows"), api("/api/kb"), refreshFiles()]);
  renderFlowList();
  $("#tpl-list").innerHTML = META.templates.map((t, i) => `<button class="wf-item" data-tpl="${i}">${esc(t.name)}<small>${esc(t.description)}</small></button>`).join("");
  if (editing) renderEditor();
};
function renderFlowList() {
  $("#flow-list").innerHTML = FLOWS.length
    ? FLOWS.map((f) => `<button class="wf-item ${editing?.id === f.id ? "active" : ""}" data-flow="${f.id}">${esc(f.name)}<small>${f.nodes.length} 個節點${f.schedule?.enabled ? " · ⏰ 已排程" : ""}</small></button>`).join("")
    : `<p class="hint">（尚無）</p>`;
}
$("#tab-flows aside").addEventListener("click", async (e) => {
  const f = e.target.closest("[data-flow]");
  const t = e.target.closest("[data-tpl]");
  if (f) {
    addMenuOpen = false;
    editing = structuredClone(FLOWS.find((x) => x.id === f.dataset.flow));
    renderFlowList();
    renderEditor();
  }
  if (t) {
    const tpl = structuredClone(META.templates[Number(t.dataset.tpl)]);
    editing = await post("/api/flows", tpl);
    FLOWS = await api("/api/flows");
    renderFlowList();
    renderEditor();
    toast("已從範本建立，可直接修改後執行");
  }
});
$("#flow-new").addEventListener("click", async () => {
  editing = await post("/api/flows", { name: "新的工作流", description: "", inputLabel: "輸入", nodes: [{ id: "n1", type: "llm", prompt: "{{input}}", out: "ai" }] });
  FLOWS = await api("/api/flows");
  renderFlowList();
  renderEditor();
});

function fieldInput(node, key, def) {
  const v = node[key] ?? def.default ?? "";
  const a = `data-k="${key}"`;
  switch (def.type) {
    case "textarea":
      return `<textarea ${a} rows="${key === "prompt" ? 5 : 2}">${esc(v)}</textarea>`;
    case "number":
      return `<input type="number" ${a} value="${esc(v)}" />`;
    case "checkbox":
      return `<input type="checkbox" ${a} ${v ? "checked" : ""} style="width:auto" />`;
    case "select":
      return `<select ${a}>${Object.entries(def.options).map(([k, l]) => `<option value="${esc(k)}" ${k === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    case "kb":
      return `<select ${a}><option value="">（請選擇知識庫）</option>${KBS.map((k) => `<option value="${k.id}" ${k.id === v ? "selected" : ""}>${esc(k.name)}</option>`).join("")}</select>`;
    case "file":
      return `<select ${a}><option value="">（請選擇檔案，或到「📁 檔案」上傳）</option>${FILES.map((f) => `<option value="${f.id}" ${f.id === v ? "selected" : ""}>${esc(f.name)}</option>`).join("")}</select>`;
    default:
      return `<input ${a} value="${esc(v)}" />`;
  }
}

function availableVars(upto) {
  const vars = ["input", "today", "now"];
  editing.nodes.slice(0, upto).forEach((n) => {
    const out = n.out ?? META.nodeTypes[n.type]?.out;
    if (out) vars.push(out);
  });
  return vars;
}

function nodeHtml(n, i) {
  const def = META.nodeTypes[n.type];
  const out = n.out ?? def.out;
  return `<div class="node ${n.disabled ? "disabled" : ""}" data-i="${i}">
    <div class="nhead" data-toggle="${i}">
      <span class="nstate">${i + 1}.</span>
      <span class="ntitle">${esc(n.title || def.label)}</span>
      ${out ? `<span class="nvar">→ {{${esc(out)}}}</span>` : ""}
      <button class="small" data-op="up" title="上移">↑</button>
      <button class="small" data-op="down" title="下移">↓</button>
      <button class="small" data-op="toggle" title="停用/啟用">${n.disabled ? "啟用" : "停用"}</button>
      <button class="small" data-op="rm" title="刪除">✕</button>
    </div>
    <div class="nlog"></div>
    <div class="nbody">
      <p class="hint">${esc(def.desc)}</p>
      ${Object.entries(def.fields).map(([k, d]) => `<div class="f"><label>${esc(d.label)}</label>${fieldInput(n, k, d)}</div>`).join("")}
      ${def.out ? `<div class="f"><label>輸出變數名稱</label><input data-k="out" value="${esc(out)}" style="max-width:200px" /></div>` : ""}
      <p class="vars">可用變數：${availableVars(i).map((v) => `<code>{{${esc(v)}}}</code>`).join(" ")}　物件可用欄位，例如 <code>{{page.title}}</code>、<code>{{check.score}}</code></p>
    </div>
  </div>`;
}

function renderEditor() {
  const f = editing;
  const s = (f.schedule ||= { enabled: false, mode: "daily", time: "09:00", minutes: 60, input: "" });
  $("#flow-panel").innerHTML = `
    <div class="flow-head">
      <div class="wide"><label>名稱</label><input id="fl-name" value="${esc(f.name)}" /></div>
      <div class="wide"><label>說明</label><input id="fl-desc" value="${esc(f.description || "")}" /></div>
    </div>
    <h3>節點</h3>
    <div id="fl-nodes">${f.nodes.map((n, i) => nodeHtml(n, i) + `<div class="arrow">↓</div>`).join("")}</div>
    <details id="add-node-menu" ${addMenuOpen ? "open" : ""}><summary><b>＋ 新增節點</b></summary><div class="add-node">${Object.entries(META.nodeTypes).map(([k, d]) => `<button class="small" data-add="${k}" title="${esc(d.desc)}">${esc(d.label)}</button>`).join("")}</div></details>
    <div class="sched">
      <label><input type="checkbox" id="sc-on" ${s.enabled ? "checked" : ""} style="width:auto" /> ⏰ 排程自動執行</label>
      <select id="sc-mode" style="width:auto"><option value="daily" ${s.mode === "daily" ? "selected" : ""}>每天</option><option value="interval" ${s.mode === "interval" ? "selected" : ""}>每隔</option></select>
      <input id="sc-time" type="time" value="${esc(s.time)}" style="width:auto" class="${s.mode === "daily" ? "" : "hidden"}" />
      <span class="${s.mode === "interval" ? "" : "hidden"}" id="sc-min-wrap"><input id="sc-min" type="number" min="5" value="${esc(s.minutes)}" style="width:80px" /> 分鐘</span>
      <label>排程時的輸入</label><input id="sc-input" value="${esc(s.input || "")}" placeholder="例如要監控的網址" />
      <p class="hint">排程在本程式執行期間有效（請保持 <code>npm start</code> 執行中）。</p>
    </div>
    <h3>執行</h3>
    <label id="fl-input-label">${esc(f.inputLabel || "輸入")}</label>
    <textarea id="fl-input" rows="3" placeholder="${esc(f.inputPlaceholder || "")}"></textarea>
    <div class="row">
      <button id="fl-run" class="primary">▶ 儲存並執行</button>
      <button id="fl-stop" class="hidden">■ 停止</button>
      <button id="fl-save">💾 儲存</button>
      <button id="fl-export">⬇️ 匯出</button>
      <label class="small" style="font-weight:400">📥 匯入<input type="file" id="fl-import" accept="application/json" class="hidden" /></label>
      <button id="fl-del">🗑️ 刪除</button>
      <span id="fl-status" class="hint"></span>
    </div>
    <div class="files" id="fl-files"></div>
    <div class="markdown output" id="fl-output"></div>`;
  $$("#fl-nodes .node").forEach((el, i) => i === 0 && f.nodes.length <= 2 && el.classList.add("open"));
}

function syncNodeField(el) {
  const nodeEl = el.closest(".node");
  if (!nodeEl) return;
  const n = editing.nodes[Number(nodeEl.dataset.i)];
  const k = el.dataset.k;
  if (!k) return;
  n[k] = el.type === "checkbox" ? el.checked : el.type === "number" ? (el.value === "" ? undefined : Number(el.value)) : el.value;
}

$("#flow-panel").addEventListener("input", (e) => {
  if (!editing) return;
  const t = e.target;
  if (t.id === "fl-name") editing.name = t.value;
  else if (t.id === "fl-desc") editing.description = t.value;
  else if (t.id === "sc-on") editing.schedule.enabled = t.checked;
  else if (t.id === "sc-time") editing.schedule.time = t.value;
  else if (t.id === "sc-min") editing.schedule.minutes = Number(t.value);
  else if (t.id === "sc-input") editing.schedule.input = t.value;
  else if (t.id === "sc-mode") {
    editing.schedule.mode = t.value;
    $("#sc-time").classList.toggle("hidden", t.value !== "daily");
    $("#sc-min-wrap").classList.toggle("hidden", t.value !== "interval");
  } else syncNodeField(t);
});
$("#flow-panel").addEventListener("change", (e) => {
  if (e.target.matches("select, input[type=checkbox]")) e.target.dispatchEvent(new Event("input", { bubbles: true }));
  if (e.target.id === "fl-import") importFlow(e.target.files[0]);
});
$("#flow-panel").addEventListener("click", async (e) => {
  if (!editing) return;
  const t = e.target.closest("button, .nhead");
  if (!t) return;
  const nodeEl = t.closest(".node");
  const i = nodeEl ? Number(nodeEl.dataset.i) : -1;
  if (t.dataset.op) {
    e.stopPropagation();
    const n = editing.nodes;
    if (t.dataset.op === "rm") n.splice(i, 1);
    if (t.dataset.op === "toggle") n[i].disabled = !n[i].disabled;
    if (t.dataset.op === "up" && i > 0) [n[i - 1], n[i]] = [n[i], n[i - 1]];
    if (t.dataset.op === "down" && i < n.length - 1) [n[i + 1], n[i]] = [n[i], n[i + 1]];
    return renderEditor();
  }
  if (t.classList.contains("nhead")) return nodeEl.classList.toggle("open");
  if (t.dataset.add) {
    addMenuOpen = true;
    const type = t.dataset.add;
    const def = META.nodeTypes[type];
    const used = new Set(editing.nodes.map((x) => x.id));
    let k = editing.nodes.length + 1;
    while (used.has("n" + k)) k++;
    const node = { id: "n" + k, type, out: def.out };
    for (const [fk, fd] of Object.entries(def.fields)) node[fk] = fd.default;
    editing.nodes.push(node);
    renderEditor();
    $$("#fl-nodes .node").at(-1).classList.add("open");
    return;
  }
  if (t.id === "fl-save") {
    await saveEditing();
    toast("已儲存");
  }
  if (t.id === "fl-run") runEditing();
  if (t.id === "fl-stop") flowAbort?.abort();
  if (t.id === "fl-export") {
    const { id, lastScheduledRun, updatedAt, ...rest } = editing;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(rest, null, 2)], { type: "application/json" }));
    a.download = `${editing.name}.json`;
    a.click();
  }
  if (t.id === "fl-del" && confirm(`刪除「${editing.name}」？`)) {
    await del("/api/flows?id=" + editing.id);
    editing = null;
    FLOWS = await api("/api/flows");
    renderFlowList();
    $("#flow-panel").innerHTML = `<p class="hint">已刪除。</p>`;
  }
});
async function importFlow(file) {
  if (!file) return;
  try {
    const f = JSON.parse(await file.text());
    if (!Array.isArray(f.nodes)) throw new Error("格式不正確（缺少 nodes）");
    delete f.id;
    editing = await post("/api/flows", f);
    FLOWS = await api("/api/flows");
    renderFlowList();
    renderEditor();
    toast("已匯入");
  } catch (e) {
    toast("匯入失敗：" + e.message);
  }
}
async function saveEditing() {
  editing = await post("/api/flows", editing);
  FLOWS = await api("/api/flows");
  renderFlowList();
}

async function runEditing() {
  const usesAi = editing.nodes.some((n) => !n.disabled && ["llm", "llm_each", "translate", "summarize", "extract"].includes(n.type));
  if (usesAi && needKey()) return;
  await saveEditing();
  const input = $("#fl-input").value;
  const nodes = $$("#fl-nodes .node");
  nodes.forEach((n) => {
    n.classList.remove("running", "done", "error", "stopped");
    $(".nlog", n).textContent = "";
    $(".nstate", n).textContent = `${Number(n.dataset.i) + 1}.`;
  });
  const nodeById = (id) => nodes[editing.nodes.findIndex((n) => n.id === id)];
  const out = $("#fl-output");
  const live = liveMarkdown(out);
  live.set("");
  $("#fl-files").innerHTML = "";
  $("#fl-run").disabled = true;
  $("#fl-stop").classList.remove("hidden");
  $("#fl-status").textContent = "執行中…";
  flowAbort = new AbortController();
  const files = [];
  let streamingNode = null;
  const t0 = Date.now();
  try {
    await streamPost(
      "/api/flows/run",
      { id: editing.id, input },
      (ev) => {
        const el = ev.node && nodeById(ev.node);
        if (ev.type === "node-start" && el) {
          el.classList.add("running");
          $(".nstate", el).textContent = "⏳";
          el.scrollIntoView({ block: "nearest", behavior: "smooth" });
        } else if (ev.type === "log" && el) {
          const log = $(".nlog", el);
          log.textContent += (log.textContent ? "\n" : "") + ev.message;
          log.scrollTop = log.scrollHeight;
        } else if (ev.type === "text") {
          if (streamingNode !== ev.node) {
            streamingNode = ev.node;
            live.set("");
          }
          live.add(ev.delta);
        } else if (ev.type === "file") {
          files.push(ev.file);
          $("#fl-files").innerHTML = fileLinks(files);
        } else if (ev.type === "node-done" && el) {
          el.classList.replace("running", "done");
          $(".nstate", el).textContent = "✅";
          if (ev.preview && streamingNode !== ev.node) live.set(ev.preview + (ev.preview.length >= 1500 ? "\n\n…" : ""));
        } else if (ev.type === "node-error" && el) {
          el.classList.replace("running", "error");
          $(".nstate", el).textContent = "❌";
          $(".nlog", el).textContent += "\n錯誤：" + ev.message;
          el.classList.add("open");
        } else if (ev.type === "stopped" && el) {
          el.classList.replace("running", "stopped");
          $(".nstate", el).textContent = "⏹";
        } else if (ev.type === "done") {
          if (ev.output) live.set(ev.output);
          const u = ev.usage ? ` · ${usageText(ev.usage)}` : "";
          $("#fl-status").textContent =
            ev.status === "stopped" ? `⏹ 條件不成立，已停止後續節點（${((Date.now() - t0) / 1000).toFixed(1)} 秒）${u}` : `✅ 完成（${((Date.now() - t0) / 1000).toFixed(1)} 秒）${u}`;
        }
      },
      flowAbort.signal,
    );
  } catch (e) {
    $("#fl-status").textContent = e.name === "AbortError" ? "已停止" : "❌ " + e.message;
  } finally {
    $("#fl-run").disabled = false;
    $("#fl-stop").classList.add("hidden");
    flowAbort = null;
  }
}

// ---------------- 初始化 ----------------
(async () => {
  try {
    META = await api("/api/meta");
  } catch (e) {
    document.body.insertAdjacentHTML("afterbegin", `<div class="banner">無法連線到伺服器：${esc(e.message)}</div>`);
    return;
  }
  setReady(META.ready);
  $("#doc-lang").innerHTML = Object.entries(META.languages).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
  showTab(location.hash.slice(1) || "home");
})();
