// 瀏覽器端到端測試：用真的瀏覽器操作每個頁面，並「從表單」辦理每一項服務。
// 執行：npm run test:ui（需要 Playwright：npm i -D playwright && npx playwright install chromium）
// 外部服務（網站、AI、學術 API、Webhook）全部由 test/world.js 模擬，不需網路與金鑰。
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startStack, FILES } from "./helpers.js";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.log("略過：未安裝 Playwright（npm i -D playwright && npx playwright install chromium）");
  process.exit(0);
}

const SHOTS = process.env.UI_SHOTS || path.join(os.tmpdir(), "studio-ui-shots");
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
let failures = 0;
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push(`✔ ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    failures++;
    results.push(`✖ ${name}\n    ${String(e.message).split("\n").slice(0, 4).join("\n    ")}`);
  }
  console.log(results.at(-1));
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg || "檢查失敗");
};
// 以記憶體中的檔案上傳（保留中文檔名；部分環境的 Playwright 無法處理含中文的「路徑」）
const fileArg = (name) => ({ name, mimeType: "application/octet-stream", buffer: fs.readFileSync(path.join(FILES, name)) });

const S = await startStack();
const { world, BASE } = S;
const browser = await chromium.launch();
const consoleErrors = [];
async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true, ...opts });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => consoleErrors.push(`[pageerror] ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/favicon|status of (4\d\d|502)/.test(m.text()) && consoleErrors.push(`[console] ${m.text()}`));
  page.on("response", (r) => r.status() >= 500 && r.status() !== 502 && consoleErrors.push(`[HTTP ${r.status()}] ${r.request().method()} ${decodeURIComponent(r.url())}`));
  page.setDefaultTimeout(20000);
  return page;
}
const p = await newPage();
const go = async (hash) => {
  await p.goto(BASE + "/" + hash);
  await p.waitForSelector(".page-title");
};

// ---------------- 首頁與選單 ----------------
await step("首頁：未設定 AI 時顯示提示；服務清單與選單完整", async () => {
  await go("#/");
  assert((await p.textContent("#main")).includes("尚未設定 AI 服務"));
  const services = (await (await fetch(BASE + "/api/services")).json()).services;
  assert((await p.locator("#main .data-table tbody tr").count()) >= services.length, "首頁應列出所有服務");
  assert((await p.locator("#sidebar .sub a").count()) === services.length, "選單應有所有服務");
  assert((await p.textContent("#ai-status")).includes("尚未設定"));
  await p.screenshot({ path: path.join(SHOTS, "01-home.png") });
});
await step("未設定 AI 時辦理需要 AI 的服務：導向系統設定", async () => {
  await go("#/svc/email-reply");
  await p.fill("#f-mail", "test");
  await p.fill("#f-points", "test");
  await p.click("#svc-submit");
  await p.waitForFunction(() => location.hash === "#/settings");
});
await step("麵包屑與選單：服務頁顯示正確位置、選單展開所屬類別", async () => {
  await go("#/svc/citation");
  assert((await p.textContent("#crumbs")).replace(/\s/g, "") === "首頁>學術研究>參考文獻格式產生", await p.textContent("#crumbs"));
  assert(await p.isVisible("#sidebar a.active:has-text('參考文獻格式產生')"));
  await p.click("#crumbs a:has-text('學術研究')");
  await p.waitForFunction(() => document.querySelector(".page-title").textContent === "學術研究");
});

// ---------------- 系統設定 ----------------
async function setProvider(kind) {
  await go("#/settings");
  if (kind === "claude") {
    await p.selectOption("#s-provider", "anthropic");
    await p.fill("#s-akey", "sk-ant-test");
    await p.selectOption("#s-cmodel", "claude-opus-5-5");
  } else {
    await p.selectOption("#s-provider", "openai");
    await p.fill("#s-okey", "sk-test");
    await p.fill("#s-obase", world.openai.base);
    await p.fill("#s-omodel", "mock");
  }
  await p.fill("#s-webhook", world.webhook.url);
  await p.selectOption("#s-cache", "0");
  await p.evaluate(() => (document.querySelector("#s-status").textContent = ""));
  await p.click("#s-test");
  await p.waitForFunction(() => /連線成功|連線失敗/.test(document.querySelector("#s-status").textContent));
  return p.textContent("#s-status");
}
await step("系統設定：OpenAI 相容服務連線成功", async () => {
  const st = await setProvider("openai");
  assert(st.includes("連線成功"), st);
  assert((await p.inputValue("#s-okey")).includes("•"), "金鑰應遮罩");
});
await step("系統設定：Claude 連線成功，標題列顯示模型", async () => {
  const st = await setProvider("claude");
  assert(st.includes("連線成功"), st);
  assert((await p.textContent("#ai-status")).includes("Claude Opus 5.5"), await p.textContent("#ai-status"));
  await p.screenshot({ path: path.join(SHOTS, "02-settings.png"), fullPage: true });
});

// ---------------- 檔案管理 ----------------
await step("檔案管理：一次上傳多種格式（含掃描檔、圖片、空白檔）", async () => {
  await go("#/files");
  const names = ["中文報告.pdf", "會議紀錄.docx", "報價單.docx", "庫存.xlsx", "成績.csv", "說明.txt", "頁面.html", "掃描檔.pdf", "截圖.png", "空白.txt"];
  await p.setInputFiles("#lib-upload", names.map(fileArg));
  await p.waitForFunction(() => /空白\.txt/.test(document.querySelector("#lib-status")?.textContent || ""), null, { timeout: 30000 });
  const status = await p.textContent("#lib-status");
  assert(/「空白\.txt」上傳失敗：檔案是空的/.test(status), status);
  assert(/「掃描檔\.pdf」上傳完成（掃描檔／圖片，需文字辨識）/.test(status), status);
  assert((await p.locator("#lib-table tbody tr").count()) === 9, "應有 9 個檔案");
  assert((await p.locator("#lib-table .st-stop").count()) === 2, "掃描檔與圖片應標示需文字辨識");
  await p.screenshot({ path: path.join(SHOTS, "03-files.png"), fullPage: true });
});

// ---------------- 每一項服務（從表單辦理） ----------------
// 欄位值：字串＝輸入；true/false＝勾選；{ select }；{ upload }；{ library }；{ text }；{ url }
const site = world.site.url;
const kbName = "客服資料";
const cases = {
  "official-document": { fields: { kind: { select: "函" }, org: "國立測試大學", to: "各學院", content: "函請各學院推薦評審委員。" }, word: true },
  "meeting-minutes": { fields: { title: "系務會議", doc: { upload: "會議紀錄.docx" } }, word: true },
  "email-reply": { fields: { mail: "請問能出席嗎？", points: "可以出席", tone: { select: "親切" }, lang: { select: "English" } } },
  proofread: { fields: { doc: { text: "今天的會義改到明天。" } }, word: true },
  summarize: { fields: { doc: { url: site + "/about" } }, word: true },
  compare: { fields: { a: { text: "第一條 會員應繳費。" }, b: { text: "第一條 會員應按時繳費。" } }, expectAi: 0, word: true },
  "zh-convert": { fields: { doc: { text: "这个软件的网络设置" } }, expectAi: 0, resultHas: "軟體" },
  "literature-search": { fields: { query: "meshless method", synth: true }, xlsx: true },
  "literature-review": { fields: { query: "meshless method" }, word: true },
  "paper-translate": { fields: { doc: { library: "中文報告.pdf" }, full: false }, word: true },
  citation: { fields: { dois: "10.1016/j.enganabound.2017.10.009", style: { select: "ieee" } }, expectAi: 0, resultHas: "[ieee]" },
  "research-tracker": { fields: { query: "neural network", notify: true }, webhook: true },
  ocr: { fields: { file: { library: "掃描檔.pdf" } }, word: true, resultHas: "圖書館開放時間" },
  translate: { fields: { doc: { library: "說明.txt" }, target: { select: "en" } }, word: true },
  "extract-table": { fields: { doc: { library: "報價單.docx" }, fields: "項目, 數量, 單價" }, xlsx: true },
  "data-analysis": { fields: { file: { upload: "成績.csv" } }, word: true },
  "to-markdown": { fields: { doc: { library: "庫存.xlsx" } }, expectAi: 0, resultHas: "鍵盤" },
  "site-check": { fields: { url: site, advise: true }, word: true },
  "page-monitor": { fields: { url: site + "/changing", notify: true }, twice: true, webhook: true },
  "news-digest": { fields: { feeds: site + "/rss.xml\n" + site + "/atom.xml", days: "3" } },
  "web-translate": { fields: { url: site + "/en" }, word: true },
  "web-research": { fields: { question: "大專校院數位學習補助" }, word: true, resultHas: "參考來源" },
  "site-to-kb": { fields: { url: site + "/docs/", kb: { select: kbName }, include: "/docs/" }, expectAi: 0 },
};

async function fillField(key, v) {
  const id = `#f-${key}`;
  if (typeof v === "boolean") return v ? p.check(id) : p.uncheck(id);
  if (v.select) {
    // 依顯示文字（開頭相符）或值選擇，不等待逾時
    const value = await p.$eval(id, (el, want) => [...el.options].find((o) => o.value === want || o.textContent.startsWith(want))?.value, v.select);
    if (value === undefined) throw new Error(`選單 ${key} 沒有「${v.select}」`);
    return p.selectOption(id, value);
  }
  const mode = v.upload ? "upload" : v.library ? "library" : v.text !== undefined ? "text" : v.url ? "url" : null;
  if (mode) {
    await p.check(`input[name="${key}-mode"][value="${mode}"]`);
    if (mode === "upload") return p.setInputFiles(id, fileArg(v.upload));
    if (mode === "library") return p.selectOption(`${id}-lib`, { label: v.library });
    if (mode === "text") return p.fill(`${id}-text`, v.text);
    return p.fill(`${id}-url`, v.url);
  }
  return p.fill(id, String(v));
}
async function submitService() {
  await p.click("#svc-submit");
  await p.waitForFunction(() => /辦理完成|已完成檢查|辦理失敗|已停止/.test(document.querySelector("#svc-status")?.textContent || ""), null, { timeout: 40000 });
  return p.textContent("#svc-status");
}

// 先建立知識庫（網站匯入知識庫服務要用）
await step("知識庫：建立新知識庫", async () => {
  await go("#/kb");
  await p.fill("#kb-name", kbName);
  await p.click("#kb-create button[type=submit]");
  await p.waitForFunction((n) => document.querySelector(".page-title")?.textContent === n, kbName);
});

const services = (await (await fetch(BASE + "/api/services")).json()).services;
for (const svc of services) {
  await step(`服務（表單辦理）：${svc.name}`, async () => {
    const c = cases[svc.id];
    assert(c, "測試沒有涵蓋這個服務，請在 cases 補上");
    await go(`#/svc/${svc.id}`);
    for (const [k, v] of Object.entries(c.fields)) await fillField(k, v);
    const hooks = world.webhook.received.length;
    const aiBefore = world.claude.calls.length;
    let st = await submitService();
    if (c.twice) {
      assert(/條件未成立/.test(st) && /記錄基準/.test(st), "第一次應建立基準：" + st);
      st = await submitService();
    }
    if (!st.includes("辦理完成")) throw new Error(st + " " + (await p.evaluate(() => document.querySelector("#svc-error")?.textContent || "")));
    assert(!(await p.locator("#svc-result .st-err").count()), "有步驟失敗");
    assert(!(await p.locator("#svc-result .st-wait").count()), "有步驟停留在等待中");
    if (c.expectAi === 0) assert(world.claude.calls.length === aiBefore && st.includes("未使用 AI"), "不應呼叫 AI：" + st);
    else if (svc.ai !== "none") assert(/AI 呼叫 \d+ 次/.test(st), "應顯示 AI 用量：" + st);
    if (c.webhook) assert(world.webhook.received.length === hooks + 1, "應送出通知");
    const result = await p.evaluate(() => document.querySelector("#svc-out")?.textContent || "");
    for (const bad of ["undefined", "[object Object]", "{{", "/api/outputs/"]) assert(!result.includes(bad), `結果含「${bad}」`);
    if (c.resultHas) assert(result.includes(c.resultHas), `結果應包含「${c.resultHas}」：${result.slice(0, 200)}`);
    const links = await p.locator("#svc-files a").evaluateAll((as) => as.map((a) => ({ href: a.getAttribute("href"), name: a.getAttribute("download") })));
    if (c.word) assert(links.some((l) => l.name.endsWith(".docx")), "應產出 Word：" + JSON.stringify(links));
    if (c.xlsx) assert(links.some((l) => l.name.endsWith(".xlsx")), "應產出 Excel：" + JSON.stringify(links));
    for (const l of links) {
      const res = await fetch(BASE + l.href);
      assert(res.status === 200 && (await res.arrayBuffer()).byteLength > 0, "下載失敗：" + l.name);
    }
    await p.screenshot({ path: path.join(SHOTS, `10-svc-${svc.id}.png`), fullPage: true });
  });
}

await step("服務：必填欄位未填時顯示錯誤，不送出 AI", async () => {
  await go("#/svc/official-document");
  const before = world.claude.calls.length;
  const st = await submitService();
  assert(st.includes("辦理失敗"), st);
  assert((await p.textContent("#svc-error")).includes("請填寫「事由與重點」"));
  assert(world.claude.calls.length === before);
});
await step("服務：設為定期執行，於自訂工作流程中可見", async () => {
  await go("#/svc/site-check");
  await fillField("url", site);
  await p.click("#svc-schedule-btn");
  await p.fill("#sch-time", "07:30");
  await p.click("#sch-save");
  await p.waitForFunction(() => /已建立排程/.test(document.querySelector("#toast").textContent));
  await go("#/flows");
  assert((await p.textContent("#main")).includes("網站健康檢查（定期）") && (await p.textContent("#main")).includes("每天 07:30"));
});

// ---------------- 知識庫問答 ----------------
await step("知識庫：加入檔案、網頁、文字後提問，顯示出處與用量", async () => {
  await go("#/kb");
  await p.click(`#main a:has-text('${kbName}')`);
  await p.waitForSelector("#kb-file");
  await p.setInputFiles("#kb-file", [fileArg("說明.txt")]);
  await p.click("#kb-add-file");
  await p.waitForFunction(() => /說明\.txt/.test(document.querySelector("#main").textContent) && document.querySelectorAll("[data-del-doc]").length >= 4);
  await p.fill("#kb-url", site + "/");
  await p.click("#kb-add-url");
  await p.waitForFunction(() => document.querySelectorAll("[data-del-doc]").length >= 5);
  await p.fill("#kb-text", "會員可享九折優惠。");
  await p.click("#kb-add-text");
  await p.waitForFunction(() => document.querySelectorAll("[data-del-doc]").length >= 6);
  await p.fill("#kb-q", "退貨期限是幾天？");
  await p.keyboard.press("Enter");
  await p.waitForSelector(".qa .src");
  const qa = await p.textContent(".qa:last-child");
  assert(qa.includes("七天 [1]"), qa);
  assert(qa.includes("AI 呼叫 1 次"), qa);
  await p.fill("#kb-q", "老闆的名字？");
  await p.click("#kb-ask");
  await p.waitForFunction(() => document.querySelectorAll(".qa").length === 2 && !document.querySelector("#kb-ask").disabled);
  assert((await p.locator(".qa").last().textContent()).includes("沒有相關資訊"));
  await p.screenshot({ path: path.join(SHOTS, "20-kb.png"), fullPage: true });
});

// ---------------- 自訂工作流程 ----------------
await step("自訂工作流程：從範本建立 → 新增步驟 → 調整順序 → 停用 → 執行 → 匯出 → 刪除", async () => {
  await go("#/flows");
  await p.click("[data-tpl='0']");
  await p.waitForSelector("#fl-nodes");
  const count = () => p.locator("#fl-nodes tr.node-row").count();
  const n0 = await count();
  await p.selectOption("#fl-add-type", "convert_zh");
  await p.click("#fl-add");
  assert((await count()) === n0 + 1, "新增步驟失敗");
  assert(await p.isVisible("#fl-nodes .node-detail"), "新增的步驟應展開設定");
  assert((await p.inputValue("#fl-add-type")) === "convert_zh", "新增後選單應保留選擇");
  await p.locator("#fl-nodes tr.node-row").nth(n0).locator("[data-op=up]").click();
  assert((await p.locator("#fl-nodes tr.node-row").nth(n0 - 1).textContent()).includes("繁簡轉換"), "上移失敗");
  await p.locator("#fl-nodes tr.node-row").nth(n0 - 1).locator("[data-op=toggle]").click();
  assert(await p.locator("#fl-nodes tr.node-row.disabled").count(), "停用失敗");
  await p.fill("#fl-input", site + "/en");
  await p.click("#fl-run");
  await p.waitForFunction(() => /執行完成|執行失敗|已停止/.test(document.querySelector("#fl-status").textContent), null, { timeout: 30000 });
  const st = await p.textContent("#fl-status");
  assert(st.includes("執行完成") && /AI 呼叫/.test(st), st);
  assert(await p.locator("#fl-files a").count(), "應有產出檔案");
  const dl = p.waitForEvent("download");
  await p.click("#fl-export");
  const exported = JSON.parse(fs.readFileSync(await (await dl).path(), "utf8"));
  assert(exported.nodes.length === n0 + 1 && !exported.id, "匯出內容錯誤");
  await p.screenshot({ path: path.join(SHOTS, "30-flow.png"), fullPage: true });
  p.once("dialog", (d) => d.accept());
  await p.click("#fl-del");
  await p.waitForFunction(() => location.hash === "#/flows");
});

// ---------------- 執行紀錄、首頁統計 ----------------
await step("執行紀錄：列出辦理紀錄、AI 用量與產出檔案", async () => {
  await go("#/runs");
  assert((await p.locator("#main .data-table tbody tr").count()) >= 20);
  assert((await p.textContent("#main")).includes("公文撰寫"));
});
await step("首頁：顯示本月用量與最近辦理紀錄", async () => {
  await go("#/");
  const t = await p.textContent(".stat-row");
  assert(!/本月 AI 呼叫\s*0 次/.test(t), t);
  assert((await p.textContent("#main")).includes("最近辦理紀錄"));
});

// ---------------- 深色模式、手機寬度 ----------------
const pages = ["#/", "#/svc/official-document", "#/svc/literature-search", "#/kb", "#/flows", "#/runs", "#/files", "#/settings"];
for (const [label, opts] of [
  ["深色模式", { colorScheme: "dark" }],
  ["手機寬度 390px", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }],
]) {
  await step(`${label}：所有頁面正常顯示、沒有橫向捲動或文字溢出`, async () => {
    const m = await newPage(opts);
    for (const h of pages) {
      await m.goto(BASE + "/" + h);
      await m.waitForSelector(".page-title");
      await m.waitForTimeout(150);
      const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert(overflow <= 1, `${h} 頁面橫向超出 ${overflow}px`);
      const spill = await m.evaluate(() =>
        [...document.querySelectorAll("#main p, #main label, #main h2, #main .help, #main li")]
          .filter((el) => el.offsetParent && getComputedStyle(el).overflowX === "visible" && el.scrollWidth > el.clientWidth + 2)
          .map((el) => el.textContent.slice(0, 40)),
      );
      assert(!spill.length, `${h} 有文字溢出：${spill.slice(0, 3).join(" | ")}`);
      await m.screenshot({ path: path.join(SHOTS, `40-${label}-${h.replace(/[#/]/g, "_")}.png`), fullPage: true });
    }
    if (opts.isMobile) {
      assert(!(await m.isVisible("#sidebar")), "手機版選單預設應收合");
      await m.click("#menu-toggle");
      assert(await m.isVisible("#sidebar"), "按「功能選單」應展開");
    }
    await m.context().close();
  });
}

await step("整個過程沒有任何 JavaScript 錯誤", async () => {
  assert(!consoleErrors.length, consoleErrors.slice(0, 5).join("\n"));
});

await browser.close();
S.close();
console.log(`\n${results.length - failures} 通過，${failures} 失敗。截圖：${SHOTS}`);
process.exit(failures ? 1 : 0);
