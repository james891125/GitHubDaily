// AI 辦公服務平台 —— 前端（行政系統版型）
import { miniMarkdown } from "./mini-md.js";

// =====================================================================
// 共用工具
// =====================================================================
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const md = (t) => miniMarkdown(t || "");
const main = () => $("#main");

function toast(msg, ms = 3000) {
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

/** 讀取 NDJSON 串流 */
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

function usageText(u) {
  if (!u || (!u.calls && !u.cached && !u.speech && !u.images)) return "未使用 AI（不計費）";
  const parts = [];
  if (u.calls || u.cached) {
    const tokens = (u.inputTokens + u.outputTokens).toLocaleString();
    parts.push(`AI 呼叫 ${u.calls} 次${u.cached ? `、使用快取 ${u.cached} 次（未計費）` : ""}，${u.estimated ? "約 " : ""}${tokens} tokens（輸入 ${u.inputTokens.toLocaleString()}／輸出 ${u.outputTokens.toLocaleString()}）`);
  }
  if (u.speech) parts.push(`語音轉文字 ${u.speech} 次（依錄音長度計費）`);
  if (u.images) parts.push(`圖片生成 ${u.images} 張`);
  return parts.join("；");
}
/** 精簡的用量文字（表格用） */
function shortUsage(u) {
  if (!u) return "—";
  const parts = [];
  if (u.calls) parts.push(`AI ${u.calls} 次／${(u.inputTokens + u.outputTokens).toLocaleString()} tokens`);
  if (u.speech) parts.push(`語音 ${u.speech} 次`);
  if (u.images) parts.push(`圖片 ${u.images} 張`);
  return parts.join("、") || "—";
}
const cleanName = (n) => String(n || "").replace(/^\d+_/, "");
const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : n > 1024 ? Math.round(n / 1024) + " KB" : (n || 0) + " B");
const fmtTime = (s) => (s ? new Date(s).toLocaleString("zh-TW", { hour12: false }) : "");
const STATUS = { success: ["完成", "st-ok"], error: ["失敗", "st-err"], stopped: ["條件未成立，已停止", "st-stop"], running: ["處理中", "st-run"] };
const statusHtml = (s) => `<span class="st ${(STATUS[s] || ["", ""])[1]}">${(STATUS[s] || [s])[0]}</span>`;
const AI_TAG = { none: ["不使用 AI", "tag-none"], light: ["少量 AI", ""], normal: ["使用 AI", ""], claude: ["需 Claude", "tag-claude"], speech: ["需語音服務", "tag-claude"], imagegen: ["需生圖服務", "tag-claude"] };
const aiTag = (k) => `<span class="tag ${AI_TAG[k]?.[1] || ""}">${AI_TAG[k]?.[0] || ""}</span>`;

function filesTable(files) {
  if (!files?.length) return "";
  const imgs = files.filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f.name));
  const gallery = imgs.length ? `<div class="gallery">${imgs.map((f) => `<a href="${esc(f.url)}" download="${esc(cleanName(f.name))}"><img src="${esc(f.url)}" alt="${esc(cleanName(f.name))}" /></a>`).join("")}</div>` : "";
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>檔名</th><th>大小</th><th>下載</th></tr></thead><tbody>${files
    .map((f) => `<tr><td>${esc(cleanName(f.name))}</td><td class="num">${fmtSize(f.size)}</td><td class="nowrap"><a href="${esc(f.url)}" download="${esc(cleanName(f.name))}">下載</a></td></tr>`)
    .join("")}</tbody></table></div>${gallery}`;
}

function readFileB64(file) {
  return new Promise((resolve, reject) => {
    if (file.size > 50 * 1024 * 1024) return reject(new Error(`「${file.name}」超過 50 MB`));
    const r = new FileReader();
    r.onload = () => resolve({ name: file.name, data: String(r.result).split(",")[1] || "" });
    r.onerror = () => reject(new Error("讀取檔案失敗"));
    r.readAsDataURL(file);
  });
}
async function uploadFile(file) {
  return post("/api/files", await readFileB64(file));
}

// =====================================================================
// 版面：標題列、選單、麵包屑、路由
// =====================================================================
let META = null;
let CATALOG = { categories: [], services: [] };
let FILES = [];
let KBS = [];

async function refreshStatus() {
  const [s, meta] = await Promise.all([api("/api/settings"), api("/api/meta")]);
  Object.assign(META, { ready: meta.ready, speechReady: meta.speechReady, imageReady: meta.imageReady, providers: meta.providers });
  const el = $("#ai-status");
  if (META.ready) {
    const p = meta.providers[s.provider];
    const raw = s[p.modelField] || "";
    const model = s.provider === "anthropic" ? (META.models.find((m) => m.id === raw)?.label || raw).replace(/（.*/, "") : `${p.name.replace(/（.*/, "")} ${raw}`;
    el.textContent = `AI：${model}`;
    el.classList.remove("off");
  } else {
    el.textContent = "AI：尚未設定";
    el.classList.add("off");
  }
  return s;
}

function renderSidebar(route) {
  const [page, arg] = route;
  const activeSvc = page === "svc" ? CATALOG.services.find((s) => s.id === arg) : null;
  const activeCat = activeSvc?.cat || (page === "cat" ? arg : null);
  const link = (href, text, active) => `<a href="${href}" class="${active ? "active" : ""}">${esc(text)}</a>`;
  $("#sidebar").innerHTML = `
    <div class="group">${link("#/", "首頁", page === "home")}</div>
    <div class="group"><div class="group-title">服務項目</div>
      ${CATALOG.categories
        .map(
          (c) => `<details ${c.id === activeCat ? "open" : ""} class="${c.id === activeCat ? "active-cat" : ""}"><summary>${esc(c.name)}</summary><div class="sub">
            ${CATALOG.services.filter((s) => s.cat === c.id).map((s) => link(`#/svc/${s.id}`, s.name, s.id === activeSvc?.id)).join("")}</div></details>`,
        )
        .join("")}
    </div>
    <div class="group"><div class="group-title">知識庫</div>${link("#/kb", "知識庫問答", page === "kb")}</div>
    <div class="group"><div class="group-title">進階功能</div>
      ${link("#/flows", "自訂工作流程", page === "flows")}
      ${link("#/runs", "執行紀錄", page === "runs")}
      ${link("#/files", "檔案管理", page === "files")}
      ${link("#/settings", "系統設定", page === "settings")}
    </div>`;
}

function setCrumbs(items) {
  $("#crumbs").innerHTML = [`<a href="#/">首頁</a>`, ...items.map(([t, h]) => (h ? `<a href="${h}">${esc(t)}</a>` : `<span>${esc(t)}</span>`))].join(`<span class="sep">&gt;</span>`);
  document.title = (items.length ? items.at(-1)[0] + "｜" : "") + "AI 辦公服務平台";
}

const PAGES = {};
let currentAbort = null;
async function route() {
  currentAbort?.abort();
  currentAbort = null;
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const page = parts[0] || "home";
  const r = [page, parts[1] ? decodeURIComponent(parts[1]) : undefined];
  document.body.classList.remove("menu-open");
  renderSidebar(r);
  const fn = PAGES[page] || PAGES.home;
  try {
    await fn(r[1]);
  } catch (e) {
    main().innerHTML = `<div class="alert">頁面載入失敗：${esc(e.message)}</div>`;
  }
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);
// 文件來源、檔案欄位的切換（上傳／檔案庫／貼上文字／網址）
document.addEventListener("change", (e) => {
  const box = e.target.closest("[data-docfield],[data-filefield]");
  if (box && e.target.type === "radio") $$("[data-pane]", box).forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== e.target.value));
});
$("#menu-toggle").addEventListener("click", () => document.body.classList.toggle("menu-open"));

function needKey(service, kind = "chat") {
  const ok = { chat: META.ready, speech: META.speechReady, imagegen: META.imageReady }[kind];
  if (ok) return false;
  const what = { chat: "文字 AI 的 API Key 與模型", speech: "「語音轉文字」服務", imagegen: "「圖片生成」服務" }[kind];
  toast(`「${service || "此功能"}」需要設定${what}，請先到系統設定完成設定`, 5000);
  location.hash = "#/settings";
  return true;
}

// =====================================================================
// 首頁
// =====================================================================
PAGES.home = async () => {
  setCrumbs([]);
  const [runs, usage, files] = await Promise.all([api("/api/runs"), api("/api/usage"), api("/api/files")]);
  const recent = runs.slice(0, 8);
  main().innerHTML = `
    <h2 class="page-title">歡迎使用 AI 辦公服務平台</h2>
    <p class="page-desc">整合多項開源工具的常用流程，選擇左側或下方的服務項目，填寫表單即可線上辦理。</p>
    ${META.ready ? "" : `<div class="alert">尚未設定 AI 服務，需使用 AI 的項目暫時無法辦理。請先至 <a href="#/settings">系統設定</a> 輸入 API Key。標示「不使用 AI」的服務可直接使用。</div>`}
    <div class="stat-row">
      <div>今日 AI 呼叫<b>${usage.today.calls.toLocaleString()} 次</b></div>
      <div>本月 AI 呼叫<b>${usage.month.calls.toLocaleString()} 次</b></div>
      <div>本月用量<b>${(usage.month.inputTokens + usage.month.outputTokens).toLocaleString()}</b><span class="muted">tokens</span></div>
      <div>快取節省<b>${usage.month.cached.toLocaleString()} 次</b></div>
      <div>檔案庫<b>${files.length} 份</b></div>
    </div>
    ${CATALOG.categories
      .map(
        (c) => `<div class="panel"><div class="panel-head"><span>${esc(c.name)}</span><span class="muted" style="font-weight:400">${esc(c.desc)}</span></div>
        <div class="table-wrap"><table class="data-table svc-table"><thead><tr><th style="width:190px">服務項目</th><th>說明</th><th style="width:96px">AI 使用</th></tr></thead><tbody>
        ${CATALOG.services
          .filter((s) => s.cat === c.id)
          .map((s) => `<tr><td><a href="#/svc/${s.id}">${esc(s.name)}</a>${s.schedulable ? ` <span class="tag">可定期</span>` : ""}</td><td>${esc(s.desc)}</td><td>${aiTag(s.ai)}</td></tr>`)
          .join("")}
        </tbody></table></div></div>`,
      )
      .join("")}
    <div class="panel"><div class="panel-head"><span>最近辦理紀錄</span><a href="#/runs" style="font-weight:400">查看全部</a></div>
      ${
        recent.length
          ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>時間</th><th>項目</th><th>方式</th><th>狀態</th><th>AI 用量</th></tr></thead><tbody>${recent
              .map((r) => `<tr><td class="nowrap">${fmtTime(r.startedAt)}</td><td>${esc(r.flowName)}</td><td class="nowrap">${r.trigger === "schedule" ? "定期執行" : "手動"}</td><td>${statusHtml(r.status)}</td><td class="nowrap">${shortUsage(r.usage)}</td></tr>`)
              .join("")}</tbody></table></div>`
          : `<div class="panel-body muted">尚無辦理紀錄。</div>`
      }
    </div>`;
};

PAGES.cat = async (id) => {
  const c = CATALOG.categories.find((x) => x.id === id);
  if (!c) return PAGES.home();
  setCrumbs([[c.name]]);
  main().innerHTML = `<h2 class="page-title">${esc(c.name)}</h2><p class="page-desc">${esc(c.desc)}</p>
    <table class="data-table svc-table"><thead><tr><th>服務項目</th><th>說明</th><th>AI 使用</th></tr></thead><tbody>
    ${CATALOG.services.filter((s) => s.cat === id).map((s) => `<tr><td><a href="#/svc/${s.id}">${esc(s.name)}</a></td><td>${esc(s.desc)}</td><td>${aiTag(s.ai)}</td></tr>`).join("")}
    </tbody></table>`;
};

// =====================================================================
// 服務辦理頁
// =====================================================================
const AI_NOTE = {
  none: "本服務的主要功能不使用 AI，不會產生 API 費用；只有勾選標示「AI」的選項時才會呼叫 AI。",
  light: "本服務使用少量 AI（通常 1 次呼叫，並採用較低的思考深度以節省用量）。",
  normal: "本服務會使用 AI，長文件會分段處理；同樣內容重新辦理時會使用快取，不重複計費。",
  claude: "本服務需要使用 Claude（系統設定中的文字 AI 供應商須為 Anthropic Claude）。",
  speech: "本服務需要「語音轉文字」服務（系統設定 → 語音轉文字），整理內容時另使用文字 AI。",
  imagegen: "本服務需要「圖片生成」服務（系統設定 → 圖片生成），依各服務的計價方式按張計費。",
};

function fieldHtml(f) {
  const id = `f-${f.key}`;
  const req = f.required ? `<span class="req">*</span>` : "";
  let input;
  switch (f.type) {
    case "textarea":
      input = `<textarea id="${id}" name="${f.key}" rows="${f.rows || 4}" placeholder="${esc(f.placeholder || "")}"></textarea>`;
      break;
    case "number":
      input = `<input type="number" id="${id}" name="${f.key}" value="${esc(f.default ?? "")}" placeholder="${esc(f.placeholder || "")}" />`;
      break;
    case "checkbox":
      input = `<label class="inline"><input type="checkbox" id="${id}" name="${f.key}" ${f.default ? "checked" : ""} />是</label>`;
      break;
    case "select":
      input = `<select id="${id}" name="${f.key}">${Object.entries(f.options).map(([k, l]) => `<option value="${esc(k)}" ${k === f.default ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
      break;
    case "kb":
      input = `<select id="${id}" name="${f.key}"><option value="">請選擇</option>${KBS.map((k) => `<option value="${k.id}">${esc(k.name)}</option>`).join("")}</select>
        <div class="help">${KBS.length ? "" : "目前沒有知識庫，請先到「知識庫問答」建立。"}</div>`;
      break;
    case "file": {
      const exts = (f.accept || "").split(",").filter(Boolean);
      const lib = FILES.filter((x) => !exts.length || exts.includes(x.ext));
      input = `<div data-filefield="${f.key}">
        <label class="inline"><input type="radio" name="${f.key}-mode" value="upload" checked />上傳新檔案</label>
        <label class="inline"><input type="radio" name="${f.key}-mode" value="library" />從檔案庫選擇</label>
        <div class="src-pane" data-pane="upload"><input type="file" id="${id}" accept="${esc(f.accept || "")}" /></div>
        <div class="src-pane hidden" data-pane="library"><select id="${id}-lib"><option value="">請選擇</option>${lib.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}</select></div>
      </div>`;
      break;
    }
    case "files": {
      const exts = (f.accept || "").split(",").filter(Boolean);
      const lib = FILES.filter((x) => !exts.length || exts.includes(x.ext));
      input = `<div data-filesfield="${f.key}" class="files-field">
        <div><input type="file" id="${id}" multiple accept="${esc(f.accept || "")}" /></div>
        <div class="files-lib">或從檔案庫加入：<select id="${id}-lib"><option value="">請選擇</option>${lib.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}</select></div>
        <table class="data-table files-list hidden"><thead><tr><th style="width:48px">順序</th><th>檔案</th><th style="width:170px">操作</th></tr></thead><tbody></tbody></table>
      </div>`;
      break;
    }
    case "doc":
      input = `<div data-docfield="${f.key}">
        <label class="inline"><input type="radio" name="${f.key}-mode" value="upload" checked />上傳檔案</label>
        <label class="inline"><input type="radio" name="${f.key}-mode" value="library" />檔案庫</label>
        <label class="inline"><input type="radio" name="${f.key}-mode" value="text" />貼上文字</label>
        <label class="inline"><input type="radio" name="${f.key}-mode" value="url" />網址</label>
        <div class="src-pane" data-pane="upload"><input type="file" id="${id}" accept=".pdf,.docx,.doc,.xlsx,.xls,.pptx,.ppt,.odt,.ods,.odp,.rtf,.epub,.eml,.csv,.tsv,.txt,.md,.html,.htm,.json,.xml,.srt,.vtt" /></div>
        <div class="src-pane hidden" data-pane="library"><select id="${id}-lib"><option value="">請選擇</option>${FILES.filter((x) => !x.needsOcr).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}</select></div>
        <div class="src-pane hidden" data-pane="text"><textarea id="${id}-text" rows="6"></textarea></div>
        <div class="src-pane hidden" data-pane="url"><input type="url" id="${id}-url" placeholder="https://" /></div>
      </div>`;
      break;
    default:
      input = `<input type="${f.type === "url" ? "url" : "text"}" id="${id}" name="${f.key}" value="${esc(f.default ?? "")}" placeholder="${esc(f.placeholder || "")}" />`;
  }
  return `<tr><th><label for="${id}">${req}${esc(f.label)}</label></th><td>${input}${f.help ? `<div class="help">${esc(f.help)}</div>` : ""}</td></tr>`;
}

// 多檔欄位：選擇的檔案與檔案庫項目依順序排列，可調整順序或移除
const filesState = new WeakMap();
const sizeText = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
function renderFilesList(box) {
  const items = filesState.get(box) || [];
  const t = $(".files-list", box);
  t.classList.toggle("hidden", !items.length);
  $("tbody", t).innerHTML = items
    .map((it, i) => `<tr data-i="${i}"><td class="num">${i + 1}</td><td>${esc(it.name)} <span class="muted">${it.file ? `（${sizeText(it.file.size)}，送出時上傳）` : "（檔案庫）"}</span></td><td class="nowrap"><button type="button" class="btn btn-sm" data-fop="up" ${i ? "" : "disabled"}>上移</button> <button type="button" class="btn btn-sm" data-fop="down" ${i < items.length - 1 ? "" : "disabled"}>下移</button> <button type="button" class="btn btn-sm btn-danger" data-fop="rm">移除</button></td></tr>`)
    .join("");
}
document.addEventListener("change", (e) => {
  const box = e.target.closest("[data-filesfield]");
  if (!box) return;
  const items = filesState.get(box) || [];
  if (e.target.type === "file") {
    for (const file of e.target.files) items.push({ name: file.name, file });
    e.target.value = "";
  } else if (e.target.tagName === "SELECT" && e.target.value) {
    items.push({ name: e.target.selectedOptions[0].textContent, id: e.target.value });
    e.target.value = "";
  }
  filesState.set(box, items);
  renderFilesList(box);
});
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-fop]");
  const box = b?.closest("[data-filesfield]");
  if (!box) return;
  const items = filesState.get(box) || [];
  const i = Number(b.closest("tr").dataset.i);
  if (b.dataset.fop === "rm") items.splice(i, 1);
  else {
    const j = b.dataset.fop === "up" ? i - 1 : i + 1;
    [items[i], items[j]] = [items[j], items[i]];
  }
  renderFilesList(box);
});
document.addEventListener("reset", (e) => $$("[data-filesfield]", e.target).forEach((box) => (filesState.set(box, []), renderFilesList(box))));

/** 依畫面收集表單值；上傳的檔案先送進檔案庫 */
async function collectForm(svc, status) {
  const form = {};
  for (const f of svc.fields) {
    const id = `f-${f.key}`;
    if (f.type === "checkbox") form[f.key] = $(`#${id}`).checked;
    else if (f.type === "files") {
      const box = $(`[data-filesfield="${f.key}"]`);
      const items = filesState.get(box) || [];
      const ids = [];
      for (const [i, it] of items.entries()) {
        if (!it.id) {
          status(`上傳「${it.name}」中…（${i + 1}/${items.length}）`);
          const saved = await uploadFile(it.file);
          it.id = saved.id;
          delete it.file;
        }
        ids.push(it.id);
      }
      renderFilesList(box);
      form[f.key] = ids;
    } else if (f.type === "doc" || f.type === "file") {
      const mode = $(`input[name="${f.key}-mode"]:checked`).value;
      if (mode === "upload") {
        const file = $(`#${id}`).files[0];
        if (!file) {
          form[f.key] = f.type === "doc" ? undefined : "";
          continue;
        }
        status(`上傳「${file.name}」中…`);
        const saved = await uploadFile(file);
        form[f.key] = f.type === "doc" ? { kind: "file", fileId: saved.id } : saved.id;
      } else if (mode === "library") {
        const v = $(`#${id}-lib`).value;
        form[f.key] = f.type === "doc" ? (v ? { kind: "file", fileId: v } : undefined) : v;
      } else if (mode === "text") form[f.key] = { kind: "text", text: $(`#${id}-text`).value };
      else form[f.key] = { kind: "url", url: $(`#${id}-url`).value.trim() };
    } else form[f.key] = $(`#${id}`).value;
  }
  return form;
}

PAGES.svc = async (id) => {
  const svc = CATALOG.services.find((s) => s.id === id);
  if (!svc) return PAGES.home();
  const cat = CATALOG.categories.find((c) => c.id === svc.cat);
  setCrumbs([[cat.name, `#/cat/${cat.id}`], [svc.name]]);
  [FILES, KBS] = await Promise.all([api("/api/files"), svc.fields.some((f) => f.type === "kb") ? api("/api/kb") : Promise.resolve(KBS)]);
  const notes = [AI_NOTE[svc.ai], ...(svc.notes || [])];
  main().innerHTML = `
    <h2 class="page-title">${esc(svc.name)}</h2>
    <p class="page-desc">${esc(svc.desc)}</p>
    <div class="notice"><b>注意事項</b><ol>${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ol></div>
    <form id="svc-form" class="panel" novalidate>
      <div class="panel-head">申請資料<span class="muted" style="font-weight:400"><span style="color:var(--red)">*</span> 為必填欄位</span></div>
      <table class="form-table"><tbody>${svc.fields.map(fieldHtml).join("")}</tbody></table>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary" id="svc-submit">送出</button>
        <button type="reset" class="btn">清除重填</button>
        ${svc.schedulable ? `<button type="button" class="btn" id="svc-schedule-btn">設為定期執行</button>` : ""}
        <button type="button" class="btn hidden" id="svc-stop">停止</button>
      </div>
      ${
        svc.schedulable
          ? `<div class="panel-body hidden" id="svc-schedule" style="border-top:1px solid var(--line)">
        <b>定期執行設定</b>：每天 <input type="time" id="sch-time" value="08:00" style="width:auto" /> 執行
        <button type="button" class="btn btn-sm btn-primary" id="sch-save">建立排程</button>
        <div class="help muted">排程會依目前填寫的內容定期辦理，可在「自訂工作流程」中修改或停用。程式需保持執行中。</div></div>`
          : ""
      }
    </form>
    <div id="svc-result"></div>`;

  const form = $("#svc-form");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    runService(svc);
  });
  $("#svc-stop").addEventListener("click", () => currentAbort?.abort());
  $("#svc-schedule-btn")?.addEventListener("click", () => $("#svc-schedule").classList.toggle("hidden"));
  $("#sch-save")?.addEventListener("click", async () => {
    try {
      const values = await collectForm(svc, () => {});
      const f = await post("/api/services/schedule", { id: svc.id, form: values, schedule: { mode: "daily", time: $("#sch-time").value } });
      toast(`已建立排程「${f.name}」，每天 ${f.schedule.time} 執行`);
      $("#svc-schedule").classList.add("hidden");
    } catch (err) {
      toast("建立排程失敗：" + err.message, 5000);
    }
  });
};

async function runService(svc) {
  if (svc.ai === "speech" || svc.ai === "imagegen" ? needKey(svc.name, svc.ai) : svc.ai !== "none" && needKey(svc.name)) return;
  const box = $("#svc-result");
  const nodes = svc.nodes;
  box.innerHTML = `<div class="panel"><div class="panel-head"><span>辦理進度</span><span id="svc-status" class="muted" style="font-weight:400"></span></div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th style="width:48px">步驟</th><th>項目</th><th style="width:90px">狀態</th><th>說明</th></tr></thead><tbody>
    ${nodes.map((n, i) => `<tr data-node="${n.id}"><td class="num">${i + 1}</td><td>${esc(n.title || META.nodeTypes[n.type]?.label || n.type)}</td><td><span class="st st-wait">等待中</span></td><td><div class="steplog"></div></td></tr>`).join("")}
    </tbody></table></div></div>
    <div class="panel hidden" id="svc-files-panel"><div class="panel-head">產出檔案</div><div id="svc-files"></div></div>
    <div class="panel hidden" id="svc-out-panel"><div class="panel-head"><span>辦理結果</span><button class="btn btn-sm" id="svc-copy" type="button">複製文字</button></div><div class="panel-body"><div class="result" id="svc-out"></div></div></div>`;
  const status = (t) => ($("#svc-status").textContent = t);
  const row = (id) => $(`tr[data-node="${id}"]`, box);
  const setSt = (id, text, cls) => {
    const r = row(id);
    if (r) r.children[2].innerHTML = `<span class="st ${cls}">${text}</span>`;
  };
  const out = $("#svc-out");
  const live = liveMarkdown(out);
  let streaming = null;
  const files = [];
  const submit = $("#svc-submit");
  submit.disabled = true;
  $("#svc-stop").classList.remove("hidden");
  currentAbort = new AbortController();
  const t0 = Date.now();
  let usage = null;
  let final = null;
  try {
    status("資料處理中…");
    const form = await collectForm(svc, status);
    status("辦理中…");
    await streamPost(
      "/api/services/run",
      { id: svc.id, form },
      (ev) => {
        if (ev.type === "node-start") {
          setSt(ev.node, "處理中", "st-run");
        } else if (ev.type === "node-skip") {
          setSt(ev.node, "略過", "st-skip");
          const r = row(ev.node);
          if (r) $(".steplog", r).textContent = "未勾選此選項";
        } else if (ev.type === "log" && ev.node !== "_prepare") {
          const r = row(ev.node);
          if (r) {
            const l = $(".steplog", r);
            l.textContent += (l.textContent ? "\n" : "") + ev.message;
          }
        } else if (ev.type === "log") status(ev.message);
        else if (ev.type === "text") {
          $("#svc-out-panel").classList.remove("hidden");
          if (streaming !== ev.node) {
            streaming = ev.node;
            live.set("");
          }
          live.add(ev.delta);
        } else if (ev.type === "file") {
          files.push(ev.file);
          $("#svc-files-panel").classList.remove("hidden");
          $("#svc-files").innerHTML = filesTable(files);
        } else if (ev.type === "node-done") setSt(ev.node, "完成", "st-ok");
        else if (ev.type === "node-error") {
          setSt(ev.node, "失敗", "st-err");
          const r = row(ev.node);
          if (r) $(".steplog", r).textContent += (r.textContent ? "\n" : "") + ev.message;
        } else if (ev.type === "stopped") setSt(ev.node, "未成立", "st-stop");
        else if (ev.type === "done") final = ev;
        else if (ev.type === "usage") usage = ev.usage;
      },
      currentAbort.signal,
    );
    if (final?.output) {
      $("#svc-out-panel").classList.remove("hidden");
      live.set(final.output);
    }
    $$("tr[data-node] .st-wait", box).forEach((s) => ((s.textContent = "未執行"), (s.className = "st st-skip")));
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    status(
      final?.status === "stopped"
        ? `已完成檢查（${secs} 秒）：條件未成立，後續步驟未執行。${svc.id === "page-monitor" ? "第一次執行會記錄基準；之後內容有變動時才會通知。" : ""}　${usageText(usage)}`
        : `辦理完成（${secs} 秒）。${usageText(usage)}`,
    );
  } catch (e) {
    status(e.name === "AbortError" ? "已停止" : "辦理失敗");
    box.insertAdjacentHTML("afterbegin", `<div class="alert" id="svc-error">${esc(e.name === "AbortError" ? "已停止辦理。" : e.message)}</div>`);
  } finally {
    submit.disabled = false;
    $("#svc-stop").classList.add("hidden");
    currentAbort = null;
  }
  $("#svc-copy")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(live.text);
      toast("已複製");
    } catch {
      toast("無法複製，請手動選取文字");
    }
  });
  box.scrollIntoView({ behavior: "smooth", block: "start" });
}

// =====================================================================
// 知識庫
// =====================================================================
const chatHistory = {};
PAGES.kb = async (id) => {
  KBS = await api("/api/kb");
  if (!id) {
    setCrumbs([["知識庫問答"]]);
    main().innerHTML = `<h2 class="page-title">知識庫問答</h2>
      <p class="page-desc">將規章、手冊、FAQ 等文件放入知識庫後，AI 只會根據這些資料回答，並標示出處。</p>
      <div class="panel"><div class="panel-head">知識庫列表</div>
        ${
          KBS.length
            ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>名稱</th><th>文件數</th><th>段落數</th><th>最後更新</th></tr></thead><tbody>${KBS.map((k) => `<tr><td><a href="#/kb/${k.id}">${esc(k.name)}</a></td><td class="num">${k.docs}</td><td class="num">${k.chunks}</td><td class="nowrap">${fmtTime(k.updatedAt)}</td></tr>`).join("")}</tbody></table></div>`
            : `<div class="panel-body muted">尚未建立知識庫。</div>`
        }</div>
      <form class="panel" id="kb-create"><div class="panel-head">新增知識庫</div>
        <table class="form-table"><tbody><tr><th><span class="req">*</span>名稱</th><td><input id="kb-name" placeholder="例：學生事務規章" /></td></tr>
        <tr><th>說明</th><td><input id="kb-desc" /></td></tr></tbody></table>
        <div class="form-actions"><button class="btn btn-primary" type="submit">建立</button></div></form>`;
    $("#kb-create").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = $("#kb-name").value.trim();
      if (!name) return toast("請填寫名稱");
      const k = await post("/api/kb", { name, description: $("#kb-desc").value });
      location.hash = `#/kb/${k.id}`;
    });
    return;
  }
  const k = await api("/api/kb/detail?id=" + id);
  setCrumbs([["知識庫問答", "#/kb"], [k.name]]);
  chatHistory[id] ||= [];
  main().innerHTML = `<h2 class="page-title">${esc(k.name)}</h2>
    <p class="page-desc">${esc(k.description || "")}　共 ${k.docs.length} 份文件、${k.chunks} 個段落。</p>
    <div class="panel"><div class="panel-head"><span>提問</span><button class="btn btn-sm" id="kb-clear" type="button">清除對話</button></div>
      <div class="panel-body"><div id="kb-chat"></div>
      <table class="form-table"><tbody><tr><th>問題</th><td><textarea id="kb-q" rows="2" placeholder="例：學生請假需要哪些證明？（Enter 送出，Shift+Enter 換行）"></textarea></td></tr></tbody></table>
      <div class="form-actions"><button class="btn btn-primary" id="kb-ask" type="button">送出問題</button></div></div></div>
    <div class="panel"><div class="panel-head">文件清單</div>
      ${
        k.docs.length
          ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>文件</th><th>字數</th><th>段落</th><th>來源</th><th>操作</th></tr></thead><tbody>${k.docs
              .map((d) => `<tr><td>${esc(d.title)}</td><td class="num">${d.chars.toLocaleString()}</td><td class="num">${d.chunks}</td><td>${d.source ? `<a href="${esc(d.source)}" target="_blank" rel="noopener">${esc(d.source)}</a>` : "上傳／貼上"}</td><td><button class="btn btn-sm btn-danger" data-del-doc="${d.id}" type="button">移除</button></td></tr>`)
              .join("")}</tbody></table></div>`
          : `<div class="panel-body muted">尚無文件，請由下方加入。</div>`
      }</div>
    <div class="panel"><div class="panel-head">加入文件</div>
      <table class="form-table"><tbody>
        <tr><th>上傳檔案</th><td><input type="file" id="kb-file" multiple /> <button class="btn btn-sm" id="kb-add-file" type="button">加入</button><div class="help">可一次選擇多個檔案（PDF、Word、Excel、TXT、HTML）。</div></td></tr>
        <tr><th>網頁</th><td><input type="url" id="kb-url" placeholder="https://" /> <button class="btn btn-sm" id="kb-add-url" type="button">加入</button><div class="help">整個網站請使用「網站匯入知識庫」服務。</div></td></tr>
        <tr><th>貼上文字</th><td><textarea id="kb-text" rows="3"></textarea> <button class="btn btn-sm" id="kb-add-text" type="button">加入</button></td></tr>
      </tbody></table><div class="panel-body muted" id="kb-status"></div></div>
    <div class="form-actions"><button class="btn btn-danger" id="kb-del" type="button">刪除此知識庫</button></div>`;
  renderChat(id);
  const status = (m) => ($("#kb-status").textContent = m);
  const add = async (payload, label) => {
    status(`加入「${label}」中…`);
    try {
      const r = await post("/api/kb/docs", { kbId: id, ...payload });
      status(`已加入「${label}」，切分為 ${r.chunks} 段。`);
      return true;
    } catch (e) {
      status(`「${label}」加入失敗：${e.message}`);
      return false;
    }
  };
  $("#kb-add-file").onclick = async () => {
    const files = [...$("#kb-file").files];
    if (!files.length) return toast("請選擇檔案");
    let n = 0;
    for (const f of files) {
      try {
        if (await add({ file: await readFileB64(f) }, f.name)) n++;
      } catch (e) {
        status(`「${f.name}」：${e.message}`);
      }
    }
    if (n) PAGES.kb(id);
  };
  $("#kb-add-url").onclick = async () => {
    const url = $("#kb-url").value.trim();
    if (url && (await add({ url }, url))) PAGES.kb(id);
  };
  $("#kb-add-text").onclick = async () => {
    const text = $("#kb-text").value.trim();
    if (text && (await add({ text, title: text.slice(0, 30) }, "貼上的文字"))) PAGES.kb(id);
  };
  $$("[data-del-doc]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("確定移除此文件？")) return;
      await del(`/api/kb/docs?kbId=${id}&docId=${b.dataset.delDoc}`);
      PAGES.kb(id);
    }),
  );
  $("#kb-del").onclick = async () => {
    if (!confirm(`確定刪除知識庫「${k.name}」？此動作無法復原。`)) return;
    await del("/api/kb?id=" + id);
    location.hash = "#/kb";
  };
  $("#kb-clear").onclick = () => {
    chatHistory[id] = [];
    renderChat(id);
  };
  $("#kb-ask").onclick = () => askKb(id);
  $("#kb-q").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      askKb(id);
    }
  });
};

function qaHtml(q, a) {
  const src = (a?.sources || []).map((s) => `<details><summary>[${s.n}] ${esc(s.title)}${s.heading ? "／" + esc(s.heading) : ""}</summary><pre>${esc(s.text)}</pre></details>`).join("");
  return `<div class="qa"><div class="q">${esc(q.content)}</div>${a ? `<div class="a result" style="border:none;padding:0;max-height:none">${md(a.content)}</div>${src ? `<div class="src"><b>資料出處</b>${src}</div>` : ""}${a.usage ? `<div class="muted">${esc(usageText(a.usage))}</div>` : ""}` : `<div class="a muted">查詢中…</div>`}</div>`;
}
function renderChat(id) {
  const h = chatHistory[id];
  const pairs = [];
  for (let i = 0; i < h.length; i += 2) pairs.push(qaHtml(h[i], h[i + 1]));
  $("#kb-chat").innerHTML = pairs.join("") || `<p class="muted">請輸入問題，例如「這份文件的重點是什麼？」</p>`;
}
async function askKb(id) {
  const q = $("#kb-q").value.trim();
  if (!q || needKey("知識庫問答")) return;
  const h = chatHistory[id];
  const history = h.map(({ role, content }) => ({ role, content }));
  h.push({ role: "user", content: q });
  $("#kb-q").value = "";
  renderChat(id);
  const live = liveMarkdown($("#kb-chat .qa:last-child .a"));
  $("#kb-ask").disabled = true;
  let ans = null;
  try {
    await streamPost("/api/kb/ask", { kbId: id, question: q, history }, (ev) => {
      if (ev.type === "text") live.add(ev.delta);
      if (ev.type === "done") ans = { role: "assistant", content: ev.answer, sources: ev.sources };
      if (ev.type === "usage" && ans) ans.usage = ev.usage;
    });
  } catch (e) {
    ans = { role: "assistant", content: "查詢失敗：" + e.message };
  }
  h.push(ans);
  $("#kb-ask").disabled = false;
  renderChat(id);
}

// =====================================================================
// 自訂工作流程（進階）
// =====================================================================
let editing = null;
PAGES.flows = async (id) => {
  [FILES, KBS] = await Promise.all([api("/api/files"), api("/api/kb")]);
  const flows = await api("/api/flows");
  if (id) {
    editing = structuredClone(flows.find((f) => f.id === id));
    if (!editing) return (location.hash = "#/flows");
    setCrumbs([["自訂工作流程", "#/flows"], [editing.name]]);
    return renderEditor();
  }
  editing = null;
  setCrumbs([["自訂工作流程"]]);
  main().innerHTML = `<h2 class="page-title">自訂工作流程</h2>
    <p class="page-desc">進階功能：自行組合步驟，建立服務目錄以外的流程；也可在這裡管理定期執行的排程。</p>
    <div class="panel"><div class="panel-head"><span>我的工作流程</span><button class="btn btn-sm btn-primary" id="flow-new" type="button">新增空白流程</button></div>
    ${
      flows.length
        ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>名稱</th><th>步驟數</th><th>定期執行</th><th>最後修改</th></tr></thead><tbody>${flows
            .map((f) => `<tr><td><a href="#/flows/${f.id}">${esc(f.name)}</a></td><td class="num">${f.nodes.length}</td><td class="nowrap">${f.schedule?.enabled ? (f.schedule.mode === "daily" ? `每天 ${esc(f.schedule.time)}` : `每 ${f.schedule.minutes} 分鐘`) : "—"}</td><td class="nowrap">${fmtTime(f.updatedAt)}</td></tr>`)
            .join("")}</tbody></table></div>`
        : `<div class="panel-body muted">尚無自訂流程。</div>`
    }</div>
    <div class="panel"><div class="panel-head">從範本建立</div><div class="table-wrap"><table class="data-table"><thead><tr><th>範本</th><th>說明</th><th>操作</th></tr></thead><tbody>
    ${META.templates.map((t, i) => `<tr><td>${esc(t.name)}</td><td>${esc(t.description)}</td><td><button class="btn btn-sm" data-tpl="${i}" type="button">建立</button></td></tr>`).join("")}
    </tbody></table></div></div>
    <div class="panel"><div class="panel-head">匯入流程</div><div class="panel-body"><input type="file" id="flow-import" accept="application/json" /></div></div>`;
  $("#flow-new").onclick = async () => {
    const f = await post("/api/flows", { name: "新的工作流程", description: "", inputLabel: "輸入內容", nodes: [{ id: "n1", type: "llm", prompt: "{{input}}", out: "ai" }] });
    location.hash = `#/flows/${f.id}`;
  };
  $$("[data-tpl]").forEach((b) =>
    b.addEventListener("click", async () => {
      const f = await post("/api/flows", structuredClone(META.templates[Number(b.dataset.tpl)]));
      toast("已從範本建立");
      location.hash = `#/flows/${f.id}`;
    }),
  );
  $("#flow-import").onchange = async (e) => {
    try {
      const f = JSON.parse(await e.target.files[0].text());
      if (!Array.isArray(f.nodes)) throw new Error("格式不正確（缺少 nodes）");
      delete f.id;
      const saved = await post("/api/flows", f);
      location.hash = `#/flows/${saved.id}`;
    } catch (err) {
      toast("匯入失敗：" + err.message);
    }
  };
};

function nodeFieldInput(node, key, def) {
  const v = node[key] ?? def.default ?? "";
  const a = `data-k="${key}"`;
  switch (def.type) {
    case "textarea":
      return `<textarea ${a} rows="${key === "prompt" ? 5 : 2}">${esc(v)}</textarea>`;
    case "number":
      return `<input ${a} value="${esc(v)}" />`;
    case "checkbox":
      return `<label class="inline"><input type="checkbox" ${a} ${v ? "checked" : ""} />是</label>`;
    case "select":
      return `<select ${a}>${Object.entries(def.options).map(([k, l]) => `<option value="${esc(k)}" ${k === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    case "kb":
      return `<select ${a}><option value="">請選擇知識庫</option>${KBS.map((k) => `<option value="${k.id}" ${k.id === v ? "selected" : ""}>${esc(k.name)}</option>`).join("")}</select>`;
    case "files":
      return `<select ${a} multiple size="5">${FILES.map((f) => `<option value="${f.id}" ${String(v).split(",").includes(f.id) ? "selected" : ""}>${esc(f.name)}</option>`).join("")}</select><div class="help muted">按住 Ctrl（Mac 為 ⌘）可多選，依檔案庫順序處理；也可在服務中使用變數。</div>`;
    case "file":
      return `<select ${a}><option value="">請選擇檔案（可至「檔案管理」上傳）</option>${FILES.map((f) => `<option value="${f.id}" ${f.id === v ? "selected" : ""}>${esc(f.name)}</option>`).join("")}</select>`;
    default:
      return `<input ${a} value="${esc(v)}" />`;
  }
}

const openNodes = new Set();
function renderEditor() {
  const f = editing;
  const s = (f.schedule ||= { enabled: false, mode: "daily", time: "08:00", minutes: 60, input: "" });
  const vars = (i) => {
    const v = ["input", "today", "now"];
    if (f.serviceForm) v.push("form.欄位");
    f.nodes.slice(0, i).forEach((n) => {
      const o = n.out ?? META.nodeTypes[n.type]?.out;
      if (o) v.push(o);
    });
    return v;
  };
  main().innerHTML = `<h2 class="page-title">${esc(f.name)}</h2>
    ${f.serviceId ? `<div class="notice"><b>說明</b>此流程由服務「${esc(f.name.replace("（定期）", ""))}」建立，使用建立時填寫的表單內容定期執行。</div>` : ""}
    <div class="panel"><div class="panel-head">基本資料</div><table class="form-table"><tbody>
      <tr><th>流程名稱</th><td><input id="fl-name" value="${esc(f.name)}" /></td></tr>
      <tr><th>說明</th><td><input id="fl-desc" value="${esc(f.description || "")}" /></td></tr>
    </tbody></table></div>
    <div class="panel"><div class="panel-head">流程步驟</div><div class="table-wrap"><table class="data-table" id="fl-nodes"><thead><tr><th style="width:48px">順序</th><th>步驟</th><th>輸出變數</th><th style="width:90px">狀態</th><th style="width:250px">操作</th></tr></thead><tbody>
    ${f.nodes
      .map((n, i) => {
        const def = META.nodeTypes[n.type];
        const out = n.out ?? def.out;
        return `<tr class="node-row ${n.disabled ? "disabled" : ""}" data-i="${i}"><td class="num">${i + 1}</td><td>${esc(n.title || def.label)}<div class="steplog"></div></td><td>${out ? `<code>{{${esc(out)}}}</code>` : "—"}</td><td class="nst">${n.disabled ? `<span class="st st-skip">停用</span>` : `<span class="st st-wait">—</span>`}</td>
          <td class="nowrap"><button class="btn btn-sm" data-op="edit" type="button">${openNodes.has(i) ? "收合" : "設定"}</button> <button class="btn btn-sm" data-op="up" type="button">上移</button> <button class="btn btn-sm" data-op="down" type="button">下移</button> <button class="btn btn-sm" data-op="toggle" type="button">${n.disabled ? "啟用" : "停用"}</button> <button class="btn btn-sm btn-danger" data-op="rm" type="button">刪除</button></td></tr>
          ${
            openNodes.has(i)
              ? `<tr class="node-detail" data-i="${i}"><td></td><td colspan="4"><div class="muted">${esc(def.desc)}</div>
            ${Object.entries(def.fields).map(([k, d]) => `<div class="f"><label>${esc(d.label)}</label>${nodeFieldInput(n, k, d)}</div>`).join("")}
            ${def.out ? `<div class="f"><label>輸出變數名稱</label><input data-k="out" value="${esc(out)}" style="max-width:200px" /></div>` : ""}
            <div class="muted">可用變數：${vars(i).map((v) => `<code>{{${esc(v)}}}</code>`).join(" ")}</div></td></tr>`
              : ""
          }`;
      })
      .join("")}
    </tbody></table></div>
    <div class="panel-body"><select id="fl-add-type" style="width:auto">${Object.entries(META.nodeTypes).map(([k, d]) => `<option value="${k}">${esc(d.label)}</option>`).join("")}</select> <button class="btn btn-sm" id="fl-add" type="button">新增步驟</button></div></div>
    <div class="panel"><div class="panel-head">定期執行</div><table class="form-table"><tbody>
      <tr><th>啟用</th><td><label class="inline"><input type="checkbox" id="sc-on" ${s.enabled ? "checked" : ""} />啟用定期執行</label></td></tr>
      <tr><th>頻率</th><td><select id="sc-mode" style="width:auto"><option value="daily" ${s.mode === "daily" ? "selected" : ""}>每天</option><option value="interval" ${s.mode === "interval" ? "selected" : ""}>每隔數分鐘</option></select>
        <input type="time" id="sc-time" value="${esc(s.time)}" style="width:auto" class="${s.mode === "daily" ? "" : "hidden"}" />
        <span id="sc-min-wrap" class="${s.mode === "interval" ? "" : "hidden"}"><input type="number" id="sc-min" min="5" value="${esc(s.minutes)}" /> 分鐘</span></td></tr>
      <tr><th>執行時的輸入</th><td><input id="sc-input" value="${esc(s.input || "")}" /><div class="help">定期執行只在本程式執行期間有效。</div></td></tr>
    </tbody></table></div>
    <div class="panel"><div class="panel-head"><span>手動執行</span><span id="fl-status" class="muted" style="font-weight:400"></span></div>
      <table class="form-table"><tbody><tr><th>${esc(f.inputLabel || "輸入內容")}</th><td><textarea id="fl-input" rows="3" placeholder="${esc(f.inputPlaceholder || "")}"></textarea></td></tr></tbody></table>
      <div class="form-actions"><button class="btn btn-primary" id="fl-run" type="button">儲存並執行</button><button class="btn hidden" id="fl-stop" type="button">停止</button><button class="btn" id="fl-save" type="button">儲存</button><button class="btn" id="fl-export" type="button">匯出</button><button class="btn btn-danger" id="fl-del" type="button">刪除</button></div>
      <div id="fl-files"></div><div class="panel-body"><div class="result" id="fl-output"></div></div></div>`;
}

document.addEventListener("input", (e) => {
  if (!editing || !$("#fl-nodes")) return;
  const t = e.target;
  const map = { "fl-name": "name", "fl-desc": "description" };
  if (map[t.id]) return (editing[map[t.id]] = t.value);
  const sc = editing.schedule;
  if (t.id === "sc-on") return (sc.enabled = t.checked);
  if (t.id === "sc-time") return (sc.time = t.value);
  if (t.id === "sc-min") return (sc.minutes = Number(t.value));
  if (t.id === "sc-input") return (sc.input = t.value);
  if (t.id === "sc-mode") {
    sc.mode = t.value;
    $("#sc-time").classList.toggle("hidden", t.value !== "daily");
    $("#sc-min-wrap").classList.toggle("hidden", t.value !== "interval");
    return;
  }
  const row = t.closest(".node-detail");
  if (row && t.dataset.k) {
    const n = editing.nodes[Number(row.dataset.i)];
    n[t.dataset.k] = t.type === "checkbox" ? t.checked : t.multiple ? [...t.selectedOptions].map((o) => o.value).join(",") : t.value;
  }
});
document.addEventListener("change", (e) => {
  if (editing && $("#fl-nodes") && e.target.matches("select, input[type=checkbox]")) e.target.dispatchEvent(new Event("input", { bubbles: true }));
});
document.addEventListener("click", async (e) => {
  if (!editing || !$("#fl-nodes")) return;
  const b = e.target.closest("button");
  if (!b) return;
  const n = editing.nodes;
  if (b.dataset.op) {
    const i = Number(b.closest("tr").dataset.i);
    if (b.dataset.op === "edit") openNodes.has(i) ? openNodes.delete(i) : openNodes.add(i);
    if (b.dataset.op === "rm" && confirm("確定刪除此步驟？")) {
      n.splice(i, 1);
      openNodes.clear();
    }
    if (b.dataset.op === "toggle") n[i].disabled = !n[i].disabled;
    if (b.dataset.op === "up" && i > 0) [n[i - 1], n[i]] = [n[i], n[i - 1]];
    if (b.dataset.op === "down" && i < n.length - 1) [n[i + 1], n[i]] = [n[i], n[i + 1]];
    if (b.dataset.op === "up" || b.dataset.op === "down") openNodes.clear();
    return renderEditor();
  }
  if (b.id === "fl-add") {
    const type = $("#fl-add-type").value;
    const def = META.nodeTypes[type];
    const used = new Set(n.map((x) => x.id));
    let k = n.length + 1;
    while (used.has("n" + k)) k++;
    const node = { id: "n" + k, type, out: def.out };
    for (const [fk, fd] of Object.entries(def.fields)) node[fk] = fd.default;
    n.push(node);
    openNodes.add(n.length - 1);
    renderEditor();
    $("#fl-add-type").value = type;
    return;
  }
  if (b.id === "fl-save") {
    editing = await post("/api/flows", editing);
    toast("已儲存");
    return;
  }
  if (b.id === "fl-export") {
    const { id, lastScheduledRun, updatedAt, ...rest } = editing;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(rest, null, 2)], { type: "application/json" }));
    a.download = `${editing.name}.json`;
    a.click();
    return;
  }
  if (b.id === "fl-del") {
    if (!confirm(`確定刪除「${editing.name}」？`)) return;
    await del("/api/flows?id=" + editing.id);
    editing = null;
    location.hash = "#/flows";
    return;
  }
  if (b.id === "fl-stop") return currentAbort?.abort();
  if (b.id === "fl-run") return runEditing();
});

async function runEditing() {
  const usesAi = editing.nodes.some((n) => !n.disabled && ["llm", "llm_each", "translate", "summarize", "extract", "ocr", "web_research"].includes(n.type));
  if (usesAi && needKey(editing.name)) return;
  editing = await post("/api/flows", editing);
  const rows = $$("#fl-nodes tr.node-row");
  rows.forEach((r) => {
    $(".steplog", r).textContent = "";
    if (!r.classList.contains("disabled")) $(".nst", r).innerHTML = `<span class="st st-wait">等待中</span>`;
  });
  const rowOf = (id) => rows[editing.nodes.findIndex((x) => x.id === id)];
  const setSt = (id, text, cls) => {
    const r = rowOf(id);
    if (r) $(".nst", r).innerHTML = `<span class="st ${cls}">${text}</span>`;
  };
  const out = $("#fl-output");
  const live = liveMarkdown(out);
  live.set("");
  $("#fl-files").innerHTML = "";
  $("#fl-run").disabled = true;
  $("#fl-stop").classList.remove("hidden");
  $("#fl-status").textContent = "執行中…";
  currentAbort = new AbortController();
  const files = [];
  let streaming = null;
  let usage = null;
  const t0 = Date.now();
  try {
    await streamPost(
      "/api/flows/run",
      { id: editing.id, input: $("#fl-input").value },
      (ev) => {
        if (ev.type === "node-start") setSt(ev.node, "處理中", "st-run");
        else if (ev.type === "node-skip") setSt(ev.node, "略過", "st-skip");
        else if (ev.type === "log") {
          const r = rowOf(ev.node);
          if (r) {
            const l = $(".steplog", r);
            l.textContent += (l.textContent ? "\n" : "") + ev.message;
          }
        } else if (ev.type === "text") {
          if (streaming !== ev.node) {
            streaming = ev.node;
            live.set("");
          }
          live.add(ev.delta);
        } else if (ev.type === "file") {
          files.push(ev.file);
          $("#fl-files").innerHTML = filesTable(files);
        } else if (ev.type === "node-done") setSt(ev.node, "完成", "st-ok");
        else if (ev.type === "node-error") {
          setSt(ev.node, "失敗", "st-err");
          const r = rowOf(ev.node);
          if (r) $(".steplog", r).textContent += "\n錯誤：" + ev.message;
        } else if (ev.type === "stopped") setSt(ev.node, "未成立", "st-stop");
        else if (ev.type === "usage") usage = ev.usage;
        else if (ev.type === "done") {
          if (ev.output) live.set(ev.output);
          $("#fl-status").dataset.final = ev.status;
        }
      },
      currentAbort.signal,
    );
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    $("#fl-status").textContent = ($("#fl-status").dataset.final === "stopped" ? `條件未成立，已停止後續步驟（${secs} 秒）` : `執行完成（${secs} 秒）`) + "。" + usageText(usage);
  } catch (e) {
    $("#fl-status").textContent = e.name === "AbortError" ? "已停止" : "執行失敗：" + e.message;
  } finally {
    $("#fl-run").disabled = false;
    $("#fl-stop").classList.add("hidden");
    currentAbort = null;
  }
}

// =====================================================================
// 執行紀錄
// =====================================================================
PAGES.runs = async () => {
  setCrumbs([["執行紀錄"]]);
  const runs = await api("/api/runs");
  main().innerHTML = `<h2 class="page-title">執行紀錄</h2><p class="page-desc">最近 100 次辦理與工作流程執行紀錄。</p>
    ${
      runs.length
        ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>開始時間</th><th>項目</th><th>方式</th><th>狀態</th><th>AI 用量</th><th>產出檔案</th><th>明細</th></tr></thead><tbody>
      ${runs
        .map(
          (r, i) => `<tr><td class="nowrap">${fmtTime(r.startedAt)}</td><td>${esc(r.flowName)}</td><td class="nowrap">${r.trigger === "schedule" ? "定期執行" : "手動"}</td><td>${statusHtml(r.status)}${r.error ? `<div class="muted">${esc(r.error)}</div>` : ""}</td>
          <td class="nowrap">${shortUsage(r.usage)}</td>
          <td>${(r.files || []).map((f) => `<a href="${esc(f.url)}" download="${esc(cleanName(f.name))}">${esc(cleanName(f.name))}</a>`).join("<br>") || "—"}</td>
          <td><details><summary>檢視</summary><pre class="steplog" style="max-height:240px">${esc((r.logs || []).join("\n"))}</pre></details></td></tr>`,
        )
        .join("")}</tbody></table></div>`
        : `<div class="panel"><div class="panel-body muted">尚無紀錄。</div></div>`
    }`;
};

// =====================================================================
// 檔案管理
// =====================================================================
PAGES.files = async () => {
  setCrumbs([["檔案管理"]]);
  const [files, outs] = await Promise.all([api("/api/files"), api("/api/outputs")]);
  FILES = files;
  const kind = (f) => (f.needsTranscribe ? `<span class="st st-stop">音檔（需轉錄）</span>` : f.needsOcr ? `<span class="st st-stop">需文字辨識</span>` : "可直接使用");
  main().innerHTML = `<h2 class="page-title">檔案管理</h2><p class="page-desc">上傳的檔案可在各項服務中直接選用；產出檔案為各服務辦理結果。</p>
    <div class="panel"><div class="panel-head">上傳檔案</div><div class="panel-body"><input type="file" id="lib-upload" multiple />
      <div class="help muted">支援文件：PDF、Word（.docx／.doc）、Excel（.xlsx／.xls）、PowerPoint（.pptx／.ppt）、OpenDocument（.odt／.ods／.odp）、RTF、EPUB、Email（.eml）、CSV、TXT、Markdown、HTML、字幕檔；圖片：PNG、JPG、WEBP、GIF、TIFF、BMP、AVIF、SVG；音檔：MP3、M4A、WAV、WEBM、OGG、FLAC（長錄音自動分段轉錄）。單檔上限 50 MB。舊版 .doc／.xls／.ppt 需安裝 LibreOffice 才能讀取部分檔案。</div><div id="lib-status" class="muted"></div></div></div>
    <div class="panel"><div class="panel-head">檔案庫（${files.length}）</div>
    ${
      files.length
        ? `<div class="table-wrap"><table class="data-table" id="lib-table"><thead><tr><th>檔名</th><th>大小</th><th>內容</th><th>狀態</th><th>上傳時間</th><th>操作</th></tr></thead><tbody>${files
            .map((f) => `<tr><td>${esc(f.name)}</td><td class="num">${f.size ? fmtSize(f.size) : "—"}</td><td class="nowrap">${f.needsOcr || f.needsTranscribe ? "—" : `${f.chars.toLocaleString()} 字${f.pages ? `，${f.pages} 頁` : ""}`}</td><td class="nowrap">${kind(f)}</td><td class="nowrap">${fmtTime(f.addedAt)}</td><td><button class="btn btn-sm btn-danger" data-del-file="${f.id}" type="button">刪除</button></td></tr>`)
            .join("")}</tbody></table></div>`
        : `<div class="panel-body muted">尚無檔案。</div>`
    }</div>
    <div class="panel"><div class="panel-head">產出檔案（${outs.length}）</div>
    ${
      outs.length
        ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>檔名</th><th>大小</th><th>產生時間</th><th>下載</th></tr></thead><tbody>${outs
            .slice(0, 200)
            .map((f) => `<tr><td>${esc(cleanName(f.name))}</td><td class="num">${fmtSize(f.size)}</td><td class="nowrap">${fmtTime(f.at)}</td><td><a href="${esc(f.url)}" download="${esc(cleanName(f.name))}">下載</a></td></tr>`)
            .join("")}</tbody></table></div>`
        : `<div class="panel-body muted">尚無產出檔案。</div>`
    }</div>`;
  $("#lib-upload").addEventListener("change", async (e) => {
    const msgs = [];
    for (const file of e.target.files) {
      $("#lib-status").textContent = `上傳「${file.name}」中…`;
      try {
        const f = await uploadFile(file);
        msgs.push(`「${file.name}」上傳完成${f.needsTranscribe ? "（音檔，可用於錄音轉逐字稿）" : f.needsOcr ? "（掃描檔／圖片，需文字辨識）" : ""}`);
      } catch (err) {
        msgs.push(`「${file.name}」上傳失敗：${err.message}`);
      }
    }
    await PAGES.files();
    $("#lib-status").innerHTML = msgs.map(esc).join("<br>");
  });
  $$("[data-del-file]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("確定刪除此檔案？")) return;
      await del("/api/files?id=" + b.dataset.delFile);
      PAGES.files();
    }),
  );
};

// =====================================================================
// 系統設定
// =====================================================================
PAGES.settings = async () => {
  setCrumbs([["系統設定"]]);
  const [s, u, meta] = await Promise.all([api("/api/settings"), api("/api/usage"), api("/api/meta")]);
  META.providers = meta.providers;
  const P = META.providers;
  const opt = (o, v) => Object.entries(o).map(([k, l]) => `<option value="${esc(k)}" ${String(k) === String(v) ? "selected" : ""}>${esc(l)}</option>`).join("");
  const provOpts = (filter, v, none) => (none ? `<option value="">${esc(none)}</option>` : "") + Object.entries(P).filter(([, p]) => filter(p)).map(([id, p]) => `<option value="${id}" ${id === v ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  const keyRows = Object.entries(P)
    .map(([id, p]) => {
      const fields = [];
      if (p.baseField) fields.push(`<input data-s="${p.baseField}" value="${esc(s[p.baseField] || "")}" placeholder="服務網址，例如 ${id === "ollama" ? "http://localhost:11434/v1" : "https://your-server/v1"}" />`);
      if (p.keyField) fields.push(`<input type="password" data-s="${p.keyField}" value="${esc(s[p.keyField] || "")}" autocomplete="off" placeholder="${id === "anthropic" ? "sk-ant-…" : "API Key"}${p.baseField ? "（選填）" : ""}" />`);
      return `<tr data-prov="${id}"><th>${esc(p.name)}</th><td>${fields.join("<div style='height:4px'></div>") || '<span class="muted">免金鑰</span>'}<div class="help">${esc(p.note)}${p.keyUrl ? `　<a href="${esc(p.keyUrl)}" target="_blank" rel="noopener">${p.noKey ? "下載" : "申請金鑰"}</a>` : ""}</div></td><td class="nowrap prov-st">${p.ready ? '<span class="st st-ok">已設定</span>' : '<span class="st st-skip">未設定</span>'}</td></tr>`;
    })
    .join("");
  const chatModelField = P[s.provider]?.modelField || "claudeModel";
  main().innerHTML = `<h2 class="page-title">系統設定</h2>
    <p class="page-desc">金鑰儲存於本機 studio/data/settings.json（僅本機可讀），只會傳送給對應的 AI 服務。各家金鑰分開保存，切換供應商不會遺失。</p>
    <form id="settings-form">
    <div class="panel"><div class="panel-head">API 金鑰</div><div class="table-wrap"><table class="form-table"><tbody>${keyRows}</tbody></table></div></div>

    <div class="panel"><div class="panel-head">文字 AI（主要）</div><table class="form-table"><tbody>
      <tr><th><span class="req">*</span>供應商</th><td><select id="s-provider" data-s="provider">${provOpts((p) => p.can.chat, s.provider)}</select><div class="help" id="s-provider-note"></div></td></tr>
      <tr><th><span class="req">*</span>模型</th><td><input id="s-model" data-model-for="chat" list="dl-chat" value="${esc(s[chatModelField] || "")}" placeholder="按右側按鈕從 API 取得清單，或直接輸入模型名稱" />
        <datalist id="dl-chat"></datalist> <button type="button" class="btn btn-sm" data-list="chat">取得模型清單</button><div class="model-list" id="ml-chat"></div></td></tr>
      <tr id="row-effort"><th>思考深度（Claude）</th><td><select data-s="effort">${opt({ "": "預設", low: "low（最快、最省）", medium: "medium", high: "high", xhigh: "xhigh（最仔細）" }, s.effort)}</select></td></tr>
    </tbody></table></div>

    <div class="panel"><div class="panel-head">語音轉文字（錄音檔）</div><table class="form-table"><tbody>
      <tr><th>服務</th><td><select id="s-speech" data-s="speechProvider">${provOpts((p) => p.can.speech || p.can.audioInput, s.speechProvider, "不使用（或自動使用文字 AI 供應商）")}</select>
        <div class="help">Claude 無法直接處理音檔。建議：Groq（便宜、快速，有時間軸）或 OpenAI（gpt-4o-transcribe 準確度高）；Gemini、OpenRouter 也可直接聽 MP3／WAV。</div></td></tr>
      <tr><th>模型</th><td><input id="s-speech-model" data-s="speechModel" data-model-for="speech" list="dl-speech" value="${esc(s.speechModel || "")}" placeholder="留空使用建議模型" /><datalist id="dl-speech"></datalist>
        <button type="button" class="btn btn-sm" data-list="speech">取得模型清單</button><div class="model-list" id="ml-speech"></div></td></tr>
    </tbody></table></div>

    <div class="panel"><div class="panel-head">圖片生成</div><table class="form-table"><tbody>
      <tr><th>服務</th><td><select id="s-image" data-s="imageProvider">${provOpts((p) => p.can.imageGen, s.imageProvider, "不使用")}</select>
        <div class="help">Claude 無法產生圖片。OpenAI 使用 gpt-image；Gemini 使用 Imagen；OpenRouter 可選多種生圖模型。</div></td></tr>
      <tr><th>模型</th><td><input id="s-image-model" data-s="imageModel" data-model-for="image" list="dl-image" value="${esc(s.imageModel || "")}" placeholder="留空使用建議模型" /><datalist id="dl-image"></datalist>
        <button type="button" class="btn btn-sm" data-list="image">取得模型清單</button><div class="model-list" id="ml-image"></div></td></tr>
    </tbody></table></div>

    <div class="panel"><div class="panel-head">用量控管</div><table class="form-table"><tbody>
      <tr><th>用量模式</th><td><select data-s="usageMode">${opt({ economy: "省用量（建議）：翻譯、擷取等機械性工作使用較低思考深度", quality: "品質優先：所有工作都使用設定的思考深度" }, s.usageMode)}</select></td></tr>
      <tr><th>回應快取</th><td><select data-s="cacheDays" id="s-cache">${opt({ 0: "不快取", 1: "1 天", 7: "7 天（建議）", 30: "30 天" }, s.cacheDays)}</select> <button class="btn btn-sm" id="s-clear-cache" type="button">清除快取</button><div class="help">相同內容重新辦理時直接使用先前結果，不重複呼叫 AI。</div></td></tr>
      <tr><th>用量統計</th><td><div class="table-wrap"><table class="data-table" id="usage-table"><thead><tr><th>期間</th><th>AI 呼叫</th><th>快取節省</th><th>輸入 tokens</th><th>輸出 tokens</th><th>語音轉文字</th><th>圖片生成</th></tr></thead><tbody>
        ${[["今日", u.today], ["本月", u.month]].map(([t, x]) => `<tr><td>${t}</td><td class="num">${x.calls.toLocaleString()} 次</td><td class="num">${x.cached.toLocaleString()} 次</td><td class="num">${x.inputTokens.toLocaleString()}</td><td class="num">${x.outputTokens.toLocaleString()}</td><td class="num">${(x.speech || 0).toLocaleString()} 次</td><td class="num">${(x.images || 0).toLocaleString()} 張</td></tr>`).join("")}
      </tbody></table></div></td></tr>
    </tbody></table></div>
    <div class="panel"><div class="panel-head">學術論文（選填）</div><table class="form-table"><tbody>
      <tr><th>Elsevier API Key</th><td><input type="password" data-s="elsevierKey" value="${esc(s.elsevierKey)}" autocomplete="off" /><div class="help">至 dev.elsevier.com 免費申請；在有訂閱的校園網路下可取得 Elsevier 論文全文。</div></td></tr>
      <tr><th>Institution Token</th><td><input type="password" data-s="elsevierInstToken" value="${esc(s.elsevierInstToken)}" autocomplete="off" /><div class="help">校外使用時由圖書館提供。</div></td></tr>
    </tbody></table></div>
    <div class="panel"><div class="panel-head">通知</div><table class="form-table"><tbody>
      <tr><th>Webhook 網址</th><td><input data-s="webhookUrl" id="s-webhook" value="${esc(s.webhookUrl)}" placeholder="https://hooks.slack.com/… 或 https://discord.com/api/webhooks/…" /><div class="help">服務勾選「發送通知」時，結果會傳送到此網址（支援 Slack、Discord、Teams）。</div></td></tr>
    </tbody></table></div>
    <div class="form-actions"><button class="btn btn-primary" type="submit">儲存設定</button><button class="btn" type="button" id="s-test">測試文字 AI 連線</button></div>
    <div id="s-status" class="muted" style="text-align:center"></div>
    </form>`;

  const updateProvider = () => {
    const id = $("#s-provider").value;
    $("#s-provider-note").textContent = P[id]?.note || "";
    $("#row-effort").classList.toggle("hidden", id !== "anthropic");
  };
  updateProvider();
  $("#s-provider").addEventListener("change", () => {
    updateProvider();
    // 切換供應商時，帶出該供應商先前選的模型
    $("#s-model").value = s[P[$("#s-provider").value]?.modelField] || "";
    $("#ml-chat").innerHTML = "";
  });
  // 建議的語音／生圖模型
  const suggest = (sel, dl, key) => {
    const p = P[$(sel).value];
    $(dl).innerHTML = (p?.[key] || []).map((m) => `<option value="${esc(m)}">`).join("");
  };
  suggest("#s-speech", "#dl-speech", "speechModels");
  suggest("#s-image", "#dl-image", "imageModels");
  $("#s-speech").addEventListener("change", () => (suggest("#s-speech", "#dl-speech", "speechModels"), ($("#s-speech-model").value = "")));
  $("#s-image").addEventListener("change", () => (suggest("#s-image", "#dl-image", "imageModels"), ($("#s-image-model").value = "")));

  const collect = () => {
    const patch = {};
    $$("[data-s]").forEach((el) => (patch[el.dataset.s] = el.type === "checkbox" ? el.checked : el.value.trim()));
    patch.cacheDays = Number(patch.cacheDays);
    patch[P[patch.provider].modelField] = $("#s-model").value.trim();
    return patch;
  };
  let dirty = false;
  $("#settings-form").addEventListener("input", () => (dirty = true));
  const save = async () => {
    await post("/api/settings", collect());
    dirty = false;
    const fresh = await api("/api/settings");
    Object.assign(s, fresh);
    $$("[data-s]").forEach((el) => {
      if (/(Key|Token)$/.test(el.dataset.s)) el.value = fresh[el.dataset.s] || "";
    });
    await refreshStatus();
    // 更新各家金鑰的「已設定／未設定」狀態
    for (const [id, p] of Object.entries(META.providers)) {
      const cell = $(`tr[data-prov="${id}"] .prov-st`);
      if (cell) cell.innerHTML = p.ready ? '<span class="st st-ok">已設定</span>' : '<span class="st st-skip">未設定</span>';
    }
  };
  $("#settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await save();
      $("#s-status").innerHTML = `<span class="st st-ok">設定已儲存</span>`;
    } catch (err) {
      $("#s-status").innerHTML = `<span class="st st-err">儲存失敗</span>：${esc(err.message)}`;
    }
  });
  $("#s-test").addEventListener("click", async () => {
    if (dirty) await save();
    $("#s-status").textContent = "連線測試中…";
    const r = await post("/api/settings/test", {});
    $("#s-status").innerHTML = r.ok ? `<span class="st st-ok">連線成功</span>（${esc(r.model)}）` : `<span class="st st-err">連線失敗</span>：${esc(r.error)}`;
  });
  $("#s-clear-cache").addEventListener("click", async () => {
    const r = await post("/api/cache/clear", {});
    toast(`已清除 ${r.removed} 筆快取`);
  });

  // 從 API 取得模型清單（綁在每次重新產生的表單上，避免重複綁定）
  $("#settings-form").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-list]");
    const pick = e.target.closest("[data-pick]");
    if (pick) {
      const purpose = pick.closest(".model-list").id.replace("ml-", "");
      const input = $(`[data-model-for="${purpose}"]`);
      input.value = pick.dataset.pick;
      dirty = true;
      pick.closest(".model-list").innerHTML = `<div class="help">已選擇「${esc(pick.dataset.pick)}」，請按「儲存設定」。</div>`;
      return;
    }
    if (!b) return;
    const purpose = b.dataset.list;
    const provider = { chat: $("#s-provider").value, speech: $("#s-speech").value || $("#s-provider").value, image: $("#s-image").value }[purpose];
    const box = $(`#ml-${purpose}`);
    if (!provider) return (box.innerHTML = `<div class="help">請先選擇服務。</div>`);
    if (dirty) await save();
    box.innerHTML = `<div class="help">取得 ${esc(P[provider].name)} 的模型清單中…</div>`;
    try {
      const { models } = await api(`/api/models?provider=${provider}&purpose=${purpose}`);
      $(`#dl-${purpose}`).innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("");
      const hasPrice = models.some((m) => m.price);
      const hasIn = models.some((m) => m.input);
      const kind = { text: "文字", image: "圖片", audio: "音訊", file: "PDF", pdf: "PDF", video: "影片" };
      box.innerHTML = models.length
        ? `<div class="toolbar" style="margin-top:6px"><input type="search" class="ml-filter" placeholder="篩選（共 ${models.length} 個模型）" style="max-width:260px" /></div>
          <div class="table-wrap" style="max-height:320px;overflow:auto"><table class="data-table"><thead><tr><th>模型</th>${hasIn ? "<th>可輸入</th>" : ""}<th>上下文</th>${hasPrice ? "<th>價格（每百萬 tokens，美元）</th>" : ""}<th></th></tr></thead><tbody>
          ${models
            .map(
              (m) => `<tr data-q="${esc((m.id + " " + m.name).toLowerCase())}"><td>${esc(m.name)}${m.name !== m.id ? `<div class="muted">${esc(m.id)}</div>` : ""}</td>${hasIn ? `<td>${esc((m.input || []).map((x) => kind[x] || x).join("、"))}</td>` : ""}<td class="num">${m.context ? m.context.toLocaleString() : "—"}</td>${hasPrice ? `<td class="nowrap">${m.price ? `輸入 ${m.price.input ?? "—"}／輸出 ${m.price.output ?? "—"}` : "—"}</td>` : ""}<td><button type="button" class="btn btn-sm" data-pick="${esc(m.id)}">選用</button></td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : `<div class="help">這個服務沒有回傳符合用途的模型，可以直接輸入模型名稱。</div>`;
      const f = $(".ml-filter", box);
      // 注意：清單位於設定表格內，需用「> tbody > tr」只選到清單本身的資料列
      f?.addEventListener("input", () => $$(".data-table > tbody > tr", box).forEach((tr) => tr.classList.toggle("hidden", !(tr.dataset.q || "").includes(f.value.toLowerCase()))));
    } catch (err) {
      box.innerHTML = `<div class="alert">${esc(err.message)}</div>`;
    }
  });
};

// =====================================================================
// 啟動
// =====================================================================
(async () => {
  $("#today").textContent = new Date().toLocaleDateString("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });
  try {
    [META, CATALOG] = await Promise.all([api("/api/meta"), api("/api/services")]);
    await refreshStatus();
  } catch (e) {
    main().innerHTML = `<div class="alert">無法連線到伺服器：${esc(e.message)}。請確認程式（npm start）仍在執行。</div>`;
    return;
  }
  route();
})();
