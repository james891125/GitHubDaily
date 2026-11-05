// GitHubDaily 工作台 —— 前端
import { miniMarkdown } from "./mini-md.js";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------- 本地儲存 ----------
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem("ghd:" + k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem("ghd:" + k, JSON.stringify(v));
    } catch {
      toast("瀏覽器儲存空間無法使用");
    }
  },
};

let META = null;
const state = {
  settings: store.get("settings", { provider: "anthropic", key: "", model: "claude-opus-5-5", effort: "", base: "", omodel: "", gh: "" }),
  favorites: store.get("favorites", {}), // id -> project
  custom: store.get("workflows", []),
  history: store.get("history", []),
  compare: new Map(),
  explore: { offset: 0, total: 0 },
  current: null, // 正在流程頁選取的流程
  editing: null, // 編輯器中的流程索引
  abort: null,
};

function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}

function md(text) {
  if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(text || ""));
  return miniMarkdown(text);
}

function authHeaders() {
  const s = state.settings;
  const h = { "content-type": "application/json", "x-llm-provider": s.provider };
  if (s.key) h["x-llm-key"] = s.key;
  if (s.provider === "anthropic") {
    if (s.model) h["x-llm-model"] = s.model;
    if (s.effort) h["x-llm-effort"] = s.effort;
  } else {
    if (s.base) h["x-llm-base-url"] = s.base;
    if (s.omodel) h["x-llm-model"] = s.omodel;
  }
  if (s.gh) h["x-github-token"] = s.gh;
  return h;
}

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { ...authHeaders(), ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** 讀取 NDJSON 串流 */
async function streamApi(path, body, onEvent, signal) {
  const res = await fetch(path, { method: "POST", headers: authHeaders(), body: JSON.stringify(body), signal });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onEvent(JSON.parse(line));
    }
  }
}

// ---------- 分頁 ----------
function showTab(name) {
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
  if (name === "favorites") renderFavorites();
  if (name === "history") renderHistory();
  if (name === "builder") renderBuilderList();
  if (name === "workflows") renderWorkflowLists();
  history.replaceState(null, "", "#" + name);
}
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) showTab(b.dataset.tab);
});

// ---------- 探索 ----------
function projectCard(p, { reason } = {}) {
  const fav = !!state.favorites[p.id];
  const sel = state.compare.has(p.id);
  return `<div class="card ${sel ? "selected" : ""}" data-id="${p.id}">
    <h4><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>
      <button class="star" data-act="fav" title="收藏">${fav ? "⭐" : "☆"}</button></h4>
    <div class="meta"><span class="tag">${esc(p.category)}</span><span>${p.year}</span>${p.repo ? `<span>${esc(p.repo)}</span>` : ""}</div>
    <p>${esc(p.description)}</p>
    ${reason ? `<div class="reason">💡 ${esc(reason)}</div>` : ""}
    <div class="actions">
      ${p.repo ? `<button class="small" data-act="dive">🔍 AI 導讀</button>` : ""}
      <button class="small" data-act="cmp">${sel ? "✓ 已加入比較" : "⚖️ 加入比較"}</button>
    </div>
  </div>`;
}

const projectCache = new Map();
function remember(items) {
  items.forEach((p) => p.id && projectCache.set(p.id, p));
}

async function loadProjects(reset = true) {
  if (reset) state.explore.offset = 0;
  const params = new URLSearchParams({
    q: $("#q").value.trim(),
    year: $("#f-year").value,
    category: $("#f-cat").value,
    offset: state.explore.offset,
    limit: 60,
  });
  const data = await api("/api/projects?" + params);
  remember(data.items);
  state.explore.total = data.total;
  const html = data.items.map((p) => projectCard(p)).join("");
  if (reset) $("#grid").innerHTML = html;
  else $("#grid").insertAdjacentHTML("beforeend", html);
  state.explore.offset += data.items.length;
  $("#result-count").textContent = `共 ${data.total} 個專案`;
  $("#more").classList.toggle("hidden", state.explore.offset >= data.total);
}

let qTimer;
$("#q").addEventListener("input", () => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => loadProjects(), 250);
});
$("#f-year").addEventListener("change", () => loadProjects());
$("#f-cat").addEventListener("change", () => loadProjects());
$("#more").addEventListener("click", () => loadProjects(false));

document.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const card = btn.closest(".card");
  const id = Number(card?.dataset.id);
  const p = projectCache.get(id);
  if (!p) return;
  if (btn.dataset.act === "fav") {
    if (state.favorites[id]) delete state.favorites[id];
    else state.favorites[id] = p;
    store.set("favorites", state.favorites);
    $$(`.card[data-id="${id}"] .star`).forEach((s) => (s.textContent = state.favorites[id] ? "⭐" : "☆"));
  } else if (btn.dataset.act === "cmp") {
    if (state.compare.has(id)) state.compare.delete(id);
    else if (state.compare.size >= 6) return toast("最多比較 6 個專案");
    else state.compare.set(id, p);
    $$(`.card[data-id="${id}"]`).forEach((c) => {
      c.classList.toggle("selected", state.compare.has(id));
      const b = $('[data-act="cmp"]', c);
      if (b) b.textContent = state.compare.has(id) ? "✓ 已加入比較" : "⚖️ 加入比較";
    });
    updateCompareBar();
  } else if (btn.dataset.act === "dive") {
    runPreset("deep-dive", p.repo);
  }
});

function updateCompareBar() {
  $("#cmp-n").textContent = state.compare.size;
  $("#compare-bar").classList.toggle("hidden", state.compare.size === 0);
}
$("#cmp-clear").addEventListener("click", () => {
  state.compare.clear();
  updateCompareBar();
  $$(".card.selected").forEach((c) => {
    c.classList.remove("selected");
    const b = $('[data-act="cmp"]', c);
    if (b) b.textContent = "⚖️ 加入比較";
  });
});
$("#cmp-run").addEventListener("click", () => {
  if (state.compare.size < 2) return toast("請至少選擇 2 個專案");
  const ids = [...state.compare.values()].map((p) => p.repo || p.id).join(", ");
  runPreset("compare", ids);
});
$("#ai-recommend").addEventListener("click", () => {
  const q = $("#q").value.trim();
  runPreset("recommend", q);
  if (!q) $("#wf-input").focus();
});

// ---------- 流程 ----------
function allWorkflows() {
  return [...META.presets.map((w) => ({ ...w, preset: true })), ...state.custom.map((w, i) => ({ ...w, key: "custom-" + i }))];
}

function renderWorkflowLists() {
  const item = (w) =>
    `<button class="wf-item ${state.current?.key === w.key ? "active" : ""}" data-key="${esc(w.key)}">${esc(w.name)}<small>${esc(w.description || `${w.steps.length} 個步驟`)}</small></button>`;
  $("#preset-list").innerHTML = META.presets.map(item).join("");
  const customs = allWorkflows().filter((w) => !w.preset);
  $("#custom-list").innerHTML = customs.length ? customs.map(item).join("") : `<p class="hint">（尚無）</p>`;
}
$("#tab-workflows aside").addEventListener("click", (e) => {
  const b = e.target.closest(".wf-item");
  if (b) selectWorkflow(b.dataset.key);
});

function selectWorkflow(key, input) {
  const w = allWorkflows().find((x) => x.key === key);
  if (!w) return;
  state.current = w;
  $("#wf-title").textContent = w.name;
  $("#wf-desc").textContent = w.description || "";
  $("#wf-input-label").textContent = w.inputLabel || "輸入";
  $("#wf-input").placeholder = w.inputPlaceholder || "";
  if (input !== undefined) $("#wf-input").value = input;
  $("#wf-run").disabled = false;
  $("#wf-steps").innerHTML = w.steps
    .map((s, i) => `<li data-i="${i}"><span class="st">○</span>${esc(s.title || META.stepTypes[s.type]?.label || s.type)}</li>`)
    .join("");
  renderWorkflowLists();
}

function runPreset(key, input) {
  showTab("workflows");
  selectWorkflow(key, input || "");
  if (input) runCurrent();
}

$("#wf-run").addEventListener("click", runCurrent);
$("#wf-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) runCurrent();
});
$("#wf-stop").addEventListener("click", () => state.abort?.abort());

async function runCurrent() {
  const w = state.current;
  if (!w) return;
  const input = $("#wf-input").value.trim();
  if (!input) return toast("請先輸入內容");
  if (!state.settings.key && w.steps.some((s) => s.type === "llm" || s.type === "ai_select")) {
    const local = state.settings.provider === "openai" && /localhost|127\.0\.0\.1/.test(state.settings.base);
    if (!local) {
      toast("此流程需要 LLM，請先到「設定」輸入 API Key");
      return showTab("settings");
    }
  }
  const out = $("#wf-output");
  out.innerHTML = "";
  $("#wf-projects").innerHTML = "";
  $("#out-head").classList.add("hidden");
  $$("#wf-steps li").forEach((li) => {
    li.className = "";
    $(".st", li).textContent = "○";
    $("pre", li)?.remove();
  });
  $("#wf-run").disabled = true;
  $("#wf-stop").classList.remove("hidden");
  $("#wf-status").textContent = "執行中…";
  const started = Date.now();
  let text = "";
  let renderPending = false;
  let finalOutput = "";
  let lastProjects = [];
  const ac = new AbortController();
  state.abort = ac;

  const li = (i) => $(`#wf-steps li[data-i="${i}"]`);
  const logTo = (i, msg) => {
    const el = li(i);
    if (!el) return;
    let pre = $("pre", el);
    if (!pre) el.insertAdjacentHTML("beforeend", "<pre></pre>"), (pre = $("pre", el));
    pre.textContent += (pre.textContent ? "\n" : "") + msg;
  };
  let currentIndex = -1;

  try {
    await streamApi(
      "/api/workflows/run",
      { workflow: { name: w.name, steps: w.steps }, input },
      (ev) => {
        if (ev.type === "step-start") {
          currentIndex = ev.index;
          li(ev.index).className = "running";
          $(".st", li(ev.index)).textContent = "⏳";
          if (ev.stepType === "llm") {
            text = "";
            out.classList.add("streaming");
            $("#out-head").classList.remove("hidden");
          }
        } else if (ev.type === "log") {
          logTo(currentIndex, ev.message);
        } else if (ev.type === "text") {
          text += ev.delta;
          if (!renderPending) {
            renderPending = true;
            requestAnimationFrame(() => {
              out.innerHTML = md(text);
              renderPending = false;
            });
          }
        } else if (ev.type === "step-done") {
          li(ev.index).className = "done";
          $(".st", li(ev.index)).textContent = "✓";
          if (ev.result) logTo(ev.index, ev.result);
          lastProjects = ev.projects || [];
          remember(lastProjects);
          $("#wf-projects").innerHTML = lastProjects
            .map((p) => `<a class="chip" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}${p.github ? ` ⭐${p.github.stars}` : ""}</a>`)
            .join("");
        } else if (ev.type === "done") {
          finalOutput = ev.output;
        } else if (ev.type === "error") {
          throw new Error(ev.message);
        }
      },
      ac.signal,
    );
    out.classList.remove("streaming");
    out.innerHTML = md(finalOutput || text);
    $("#out-head").classList.remove("hidden");
    $("#wf-status").textContent = `✅ 完成，耗時 ${((Date.now() - started) / 1000).toFixed(1)} 秒`;
    state.lastOutput = finalOutput || text;
    addHistory({ name: w.name, input, output: finalOutput || text, projects: lastProjects.map((p) => p.name) });
  } catch (e) {
    out.classList.remove("streaming");
    if (currentIndex >= 0 && li(currentIndex)) {
      li(currentIndex).className = "error";
      $(".st", li(currentIndex)).textContent = "✗";
    }
    const msg = e.name === "AbortError" ? "已停止" : e.message;
    $("#wf-status").textContent = "❌ " + msg;
    if (text) out.innerHTML = md(text), (state.lastOutput = text);
  } finally {
    $("#wf-run").disabled = false;
    $("#wf-stop").classList.add("hidden");
    state.abort = null;
  }
}

function currentOutputText() {
  return state.lastOutput || $("#wf-output").innerText;
}
function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$("#out-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(currentOutputText());
    toast("已複製 Markdown");
  } catch {
    toast("複製失敗");
  }
});
$("#out-md").addEventListener("click", () =>
  download(`${(state.current?.name || "output").replace(/[^\w一-鿿-]+/g, "")}-${new Date().toISOString().slice(0, 10)}.md`, currentOutputText()),
);

// ---------- 歷史 ----------
function addHistory(entry) {
  state.history.unshift({ ...entry, at: new Date().toISOString() });
  state.history = state.history.slice(0, 50);
  store.set("history", state.history);
}
function renderHistory() {
  const list = $("#hist-list");
  if (!state.history.length) return (list.innerHTML = `<p class="hint">尚無紀錄。執行流程後結果會自動保存在這裡（僅存於此瀏覽器）。</p>`);
  list.innerHTML = state.history
    .map(
      (h, i) => `<details class="hist-item"><summary><b>${esc(h.name)}</b>${esc(h.input.slice(0, 60))}
      <span class="hint">　${new Date(h.at).toLocaleString()}</span></summary>
      <div class="row"><button class="small" data-h-dl="${i}">⬇️ 下載</button><button class="small" data-h-del="${i}">刪除</button></div>
      <article class="markdown">${md(h.output)}</article></details>`,
    )
    .join("");
}
$("#hist-list").addEventListener("click", (e) => {
  const dl = e.target.closest("[data-h-dl]");
  const del = e.target.closest("[data-h-del]");
  if (dl) {
    const h = state.history[Number(dl.dataset.hDl)];
    download(`${h.name.replace(/[^\w一-鿿-]+/g, "")}-${h.at.slice(0, 10)}.md`, `# ${h.name}\n\n> 輸入：${h.input}\n\n${h.output}`);
  }
  if (del) {
    state.history.splice(Number(del.dataset.hDel), 1);
    store.set("history", state.history);
    renderHistory();
  }
});
$("#hist-clear").addEventListener("click", () => {
  if (!confirm("確定清除全部歷史紀錄？")) return;
  state.history = [];
  store.set("history", []);
  renderHistory();
});

// ---------- 收藏 / 健康檢查 ----------
const healthCache = store.get("health", {});
function renderFavorites() {
  const favs = Object.values(state.favorites);
  remember(favs);
  $("#fav-empty").classList.toggle("hidden", favs.length > 0);
  $("#fav-table tbody").innerHTML = favs
    .map((p) => {
      const h = healthCache[p.repo] || {};
      const i = h.info || {};
      return `<tr data-id="${p.id}">
        <td><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a><div class="hint">${esc(p.description.slice(0, 60))}…</div></td>
        <td>${esc(p.category)}</td>
        <td>${i.stars?.toLocaleString() ?? "-"}</td>
        <td>${esc(i.language || "-")}</td>
        <td>${esc(i.license || "-")}</td>
        <td>${i.pushed_at ? i.pushed_at.slice(0, 10) : "-"}</td>
        <td>${h.error ? `<span class="badge bad" title="${esc(h.error)}">錯誤</span>` : h.health ? `<span class="badge ${h.health.level}">${h.health.label}</span>` : "-"}</td>
        <td><button class="small" data-unfav="${p.id}">移除</button></td></tr>`;
    })
    .join("");
}
$("#fav-table").addEventListener("click", (e) => {
  const b = e.target.closest("[data-unfav]");
  if (!b) return;
  delete state.favorites[b.dataset.unfav];
  store.set("favorites", state.favorites);
  renderFavorites();
});
$("#fav-check").addEventListener("click", async () => {
  const repos = Object.values(state.favorites).map((p) => p.repo).filter(Boolean);
  if (!repos.length) return toast("收藏中沒有 GitHub 專案");
  $("#fav-status").textContent = "檢查中…";
  let n = 0;
  try {
    await streamApi("/api/github/batch", { repos }, (ev) => {
      healthCache[ev.repo] = ev;
      n++;
      $("#fav-status").textContent = `檢查中… ${n}/${repos.length}`;
      renderFavorites();
    });
    store.set("health", healthCache);
    const bad = Object.values(state.favorites).filter((p) => healthCache[p.repo]?.health?.level === "bad").length;
    $("#fav-status").textContent = `完成 ${n}/${repos.length}。${bad ? `⚠️ ${bad} 個專案已封存或超過一年未更新。` : "全部正常 👍"}`;
  } catch (e) {
    $("#fav-status").textContent = "❌ " + e.message;
  }
});
$("#fav-compare").addEventListener("click", () => {
  const favs = Object.values(state.favorites);
  if (favs.length < 2) return toast("至少需要 2 個收藏");
  runPreset("compare", favs.slice(0, 8).map((p) => p.repo || p.id).join(", "));
});
$("#fav-export").addEventListener("click", () => {
  const favs = Object.values(state.favorites);
  const lines = ["# 我的開源專案收藏", "", "| 專案 | 分類 | 簡述 | Stars | 狀態 |", "|---|---|---|---|---|"];
  for (const p of favs) {
    const h = healthCache[p.repo] || {};
    lines.push(`| [${p.name}](${p.url}) | ${p.category} | ${p.description.replace(/\|/g, "/")} | ${h.info?.stars ?? "-"} | ${h.health?.label ?? "-"} |`);
  }
  download("我的收藏.md", lines.join("\n"));
});

// ---------- 流程編輯器 ----------
const FIELD_DEFS = {
  query: { label: "搜尋關鍵字（可用 {{input}}）", type: "text" },
  limit: { label: "數量上限", type: "number" },
  category: { label: "限定分類（選填）", type: "category" },
  year: { label: "限定年份（選填）", type: "number" },
  ids: { label: "專案（ID / 名稱 / owner/repo，可用 {{input}}）", type: "text" },
  pool: { label: "候選池大小", type: "number" },
  count: { label: "挑選數量", type: "number" },
  readme: { label: "同時讀取 README", type: "checkbox" },
  minStars: { label: "最少 Stars", type: "number" },
  activeOnly: { label: "排除停滯/封存", type: "checkbox" },
  minYear: { label: "最早收錄年份", type: "number" },
  sortBy: { label: "排序", type: "sort" },
  system: { label: "系統提示（選填）", type: "textarea", wide: true },
  prompt: { label: "提示模板", type: "textarea", wide: true, rows: 6 },
  maxTokens: { label: "max_tokens", type: "number" },
};
const STEP_FIELDS = {
  search: ["query", "limit", "category", "year"],
  pick: ["ids"],
  ai_select: ["query", "pool", "count"],
  github: ["readme"],
  filter: ["minStars", "activeOnly", "minYear", "sortBy", "limit"],
  llm: ["prompt", "system", "maxTokens"],
};
const STEP_DEFAULTS = {
  search: { query: "{{input}}", limit: 15 },
  pick: { ids: "{{input}}" },
  ai_select: { query: "{{input}}", pool: 150, count: 6 },
  github: { readme: false },
  filter: { activeOnly: true, sortBy: "stars", limit: 10 },
  llm: { prompt: "根據以下專案：\n{{github}}\n\n請針對「{{input}}」…" },
};

function renderBuilderList() {
  $("#builder-list").innerHTML = state.custom.length
    ? state.custom.map((w, i) => `<button class="wf-item ${state.editing === i ? "active" : ""}" data-edit="${i}">${esc(w.name)}<small>${w.steps.length} 個步驟</small></button>`).join("")
    : `<p class="hint">（尚無）</p>`;
  $("#builder-presets").innerHTML = META.presets.map((w) => `<button class="wf-item" data-clone="${esc(w.key)}">${esc(w.name)}</button>`).join("");
}
$("#tab-builder aside").addEventListener("click", (e) => {
  const ed = e.target.closest("[data-edit]");
  const cl = e.target.closest("[data-clone]");
  if (ed) editWorkflow(Number(ed.dataset.edit));
  if (cl) {
    const p = META.presets.find((w) => w.key === cl.dataset.clone);
    const { key, ...rest } = structuredClone(p);
    state.custom.push({ ...rest, name: p.name + "（自訂）" });
    saveCustom();
    editWorkflow(state.custom.length - 1);
  }
});
$("#b-new").addEventListener("click", () => {
  state.custom.push({
    name: "新流程",
    description: "",
    inputLabel: "輸入",
    inputPlaceholder: "",
    steps: [
      { id: "s1", type: "search", title: "搜尋目錄", ...STEP_DEFAULTS.search },
      { id: "s2", type: "llm", title: "LLM 處理", ...STEP_DEFAULTS.llm },
    ],
  });
  saveCustom();
  editWorkflow(state.custom.length - 1);
});
$("#b-import").addEventListener("click", () => $("#b-import-file").click());
$("#b-import-file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const wf = JSON.parse(await f.text());
    if (!Array.isArray(wf.steps)) throw new Error("缺少 steps");
    state.custom.push(wf);
    saveCustom();
    editWorkflow(state.custom.length - 1);
    toast("已匯入流程");
  } catch (err) {
    toast("匯入失敗：" + err.message);
  }
  e.target.value = "";
});

function saveCustom() {
  store.set("workflows", state.custom);
  renderBuilderList();
}

function fieldHtml(name, value, si) {
  const d = FIELD_DEFS[name];
  const attr = `data-si="${si}" data-f="${name}"`;
  let input;
  if (d.type === "textarea") input = `<textarea ${attr} rows="${d.rows || 2}">${esc(value ?? "")}</textarea>`;
  else if (d.type === "checkbox") input = `<input type="checkbox" ${attr} ${value ? "checked" : ""} style="width:auto" />`;
  else if (d.type === "category")
    input = `<select ${attr}><option value="">（不限）</option>${Object.keys(META.stats.categories)
      .sort()
      .map((c) => `<option ${c === value ? "selected" : ""}>${esc(c)}</option>`)
      .join("")}</select>`;
  else if (d.type === "sort")
    input = `<select ${attr}><option value="">（不排序）</option><option value="stars" ${value === "stars" ? "selected" : ""}>依 Stars</option></select>`;
  else input = `<input type="${d.type}" ${attr} value="${esc(value ?? "")}" />`;
  return `<div class="${d.wide ? "wide" : ""}"><label>${d.label}</label>${input}</div>`;
}

function editWorkflow(i) {
  state.editing = i;
  renderBuilderList();
  const w = state.custom[i];
  const typeOpts = (t) =>
    Object.entries(META.stepTypes)
      .map(([k, v]) => `<option value="${k}" ${k === t ? "selected" : ""}>${v.label}</option>`)
      .join("");
  $("#builder-panel").innerHTML = `
    <label>流程名稱</label><input id="b-name" value="${esc(w.name)}" />
    <label>說明</label><input id="b-desc" value="${esc(w.description || "")}" />
    <div class="row" style="gap:12px">
      <div style="flex:1"><label>輸入欄標題</label><input id="b-ilabel" value="${esc(w.inputLabel || "")}" /></div>
      <div style="flex:1"><label>輸入範例</label><input id="b-iph" value="${esc(w.inputPlaceholder || "")}" /></div>
    </div>
    <h3>步驟</h3>
    <p class="vars">可用變數：<code>{{input}}</code> 使用者輸入、<code>{{projects}}</code> 目前專案清單、<code>{{github}}</code> 含 GitHub 數據的清單、<code>{{readme}}</code> README 內容、<code>{{count}}</code> 專案數、<code>{{steps.步驟ID}}</code> 指定步驟的輸出。</p>
    <div id="b-steps">${w.steps
      .map(
        (s, si) => `<div class="step-editor">
        <div class="head"><b>${si + 1}.</b>
          <select data-si="${si}" data-f="type">${typeOpts(s.type)}</select>
          <input data-si="${si}" data-f="title" value="${esc(s.title || "")}" placeholder="步驟標題" />
          <input data-si="${si}" data-f="id" value="${esc(s.id || "")}" placeholder="ID" style="max-width:90px" title="步驟 ID（供 {{steps.ID}} 引用）" />
          <button class="small" data-mv="${si}:-1" title="上移">↑</button>
          <button class="small" data-mv="${si}:1" title="下移">↓</button>
          <button class="small" data-rm="${si}" title="刪除">✕</button>
        </div>
        <div class="fields">${(STEP_FIELDS[s.type] || []).map((f) => fieldHtml(f, s[f], si)).join("")}</div>
      </div>`,
      )
      .join("")}</div>
    <div class="row">
      ${Object.entries(META.stepTypes).map(([k, v]) => `<button class="small" data-add="${k}">＋ ${v.label}</button>`).join("")}
    </div>
    <div class="row">
      <button id="b-run" class="primary">▶ 儲存並執行</button>
      <button id="b-export">⬇️ 匯出 JSON</button>
      <button id="b-del">🗑️ 刪除流程</button>
    </div>`;
}

$("#builder-panel").addEventListener("input", (e) => {
  const w = state.custom[state.editing];
  if (!w) return;
  const map = { "b-name": "name", "b-desc": "description", "b-ilabel": "inputLabel", "b-iph": "inputPlaceholder" };
  if (map[e.target.id]) {
    w[map[e.target.id]] = e.target.value;
    return saveCustom();
  }
  const si = e.target.dataset.si;
  const f = e.target.dataset.f;
  if (si === undefined || !f) return;
  const step = w.steps[Number(si)];
  let v = e.target.type === "checkbox" ? e.target.checked : e.target.value;
  if (e.target.type === "number") v = v === "" ? undefined : Number(v);
  if (f === "type") {
    w.steps[Number(si)] = { id: step.id, title: META.stepTypes[v].label, type: v, ...STEP_DEFAULTS[v] };
    saveCustom();
    return editWorkflow(state.editing);
  }
  step[f] = v;
  store.set("workflows", state.custom);
});
$("#builder-panel").addEventListener("change", (e) => {
  if (e.target.matches("select, input[type=checkbox]")) e.target.dispatchEvent(new Event("input", { bubbles: true }));
});
$("#builder-panel").addEventListener("click", (e) => {
  const w = state.custom[state.editing];
  if (!w) return;
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.add) {
    const type = t.dataset.add;
    w.steps.push({ id: "s" + (w.steps.length + 1), type, title: META.stepTypes[type].label, ...STEP_DEFAULTS[type] });
  } else if (t.dataset.rm !== undefined) {
    w.steps.splice(Number(t.dataset.rm), 1);
  } else if (t.dataset.mv) {
    const [i, d] = t.dataset.mv.split(":").map(Number);
    const j = i + d;
    if (j < 0 || j >= w.steps.length) return;
    [w.steps[i], w.steps[j]] = [w.steps[j], w.steps[i]];
  } else if (t.id === "b-export") {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(w, null, 2)], { type: "application/json" }));
    a.download = `${w.name}.json`;
    a.click();
    return;
  } else if (t.id === "b-del") {
    if (!confirm(`刪除流程「${w.name}」？`)) return;
    state.custom.splice(state.editing, 1);
    state.editing = null;
    saveCustom();
    $("#builder-panel").innerHTML = `<p class="hint">已刪除。</p>`;
    return;
  } else if (t.id === "b-run") {
    saveCustom();
    showTab("workflows");
    selectWorkflow("custom-" + state.editing);
    $("#wf-input").focus();
    return;
  } else return;
  saveCustom();
  editWorkflow(state.editing);
});

// ---------- 設定 ----------
function loadSettingsForm() {
  const s = state.settings;
  $("#s-model").innerHTML = META.models.map((m) => `<option value="${m.id}">${esc(m.label)}</option>`).join("");
  $("#s-provider").value = s.provider;
  $("#s-key").value = s.key;
  $("#s-model").value = s.model || "claude-opus-5-5";
  $("#s-effort").value = s.effort || "";
  $("#s-base").value = s.base || "";
  $("#s-omodel").value = s.omodel || "";
  $("#s-gh").value = s.gh || "";
  toggleProvider();
  updateKeyDot();
}
function toggleProvider() {
  const oa = $("#s-provider").value === "openai";
  $("#s-claude-opts").classList.toggle("hidden", oa);
  $("#s-openai-opts").classList.toggle("hidden", !oa);
}
function updateKeyDot() {
  const s = state.settings;
  $("#key-dot").classList.toggle("on", !!s.key || (s.provider === "openai" && /localhost|127\.0\.0\.1/.test(s.base)));
}
function readSettingsForm() {
  state.settings = {
    provider: $("#s-provider").value,
    key: $("#s-key").value.trim(),
    model: $("#s-model").value,
    effort: $("#s-effort").value,
    base: $("#s-base").value.trim(),
    omodel: $("#s-omodel").value.trim(),
    gh: $("#s-gh").value.trim(),
  };
  store.set("settings", state.settings);
  updateKeyDot();
}
$("#s-provider").addEventListener("change", toggleProvider);
$("#s-save").addEventListener("click", () => {
  readSettingsForm();
  $("#s-status").textContent = "✅ 已儲存";
});
$("#s-test").addEventListener("click", async () => {
  readSettingsForm();
  $("#s-status").textContent = "測試中…";
  try {
    const r = await api("/api/llm/test", { method: "POST", body: "{}" });
    $("#s-status").textContent = r.ok ? `✅ ${r.text}（${r.model}）` : `❌ ${r.error}`;
  } catch (e) {
    $("#s-status").textContent = "❌ " + e.message;
  }
});
$("#s-clear").addEventListener("click", () => {
  if (!confirm("清除所有已儲存的金鑰？")) return;
  state.settings = { ...state.settings, key: "", gh: "" };
  store.set("settings", state.settings);
  loadSettingsForm();
  $("#s-status").textContent = "已清除";
});

// ---------- 初始化 ----------
(async function init() {
  try {
    META = await api("/api/meta");
  } catch (e) {
    $("#stats-line").textContent = "無法連線到伺服器：" + e.message;
    return;
  }
  const s = META.stats;
  $("#stats-line").textContent = `收錄 ${s.total.toLocaleString()} 個開源專案 · ${Object.keys(s.categories).length} 個分類 · ${Object.keys(s.years).length} 個年度`;
  $("#f-year").insertAdjacentHTML(
    "beforeend",
    Object.keys(s.years)
      .sort((a, b) => b - a)
      .map((y) => `<option value="${y}">${y}（${s.years[y]}）</option>`)
      .join(""),
  );
  $("#f-cat").insertAdjacentHTML(
    "beforeend",
    Object.entries(s.categories)
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `<option value="${esc(c)}">${esc(c)}（${n}）</option>`)
      .join(""),
  );
  loadSettingsForm();
  renderWorkflowLists();
  await loadProjects();
  const tab = location.hash.slice(1);
  if (tab && $("#tab-" + tab)) showTab(tab);
})();
