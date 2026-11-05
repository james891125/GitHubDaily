// 瀏覽器端到端測試：用真的瀏覽器操作每個分頁、上傳各種檔案、從介面執行每一個範本。
// 執行：npm run test:ui（需要已安裝 Playwright：npm i -D playwright && npx playwright install chromium）
// 所有外部服務（網站、AI、Webhook）都由 test/world.js 模擬，不需要網路與金鑰。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startWorld } from "./world.js";

const here = path.dirname(fileURLToPath(import.meta.url));
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
const FILES = path.join(here, "files");
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
  if (!cond) throw new Error(msg);
};

// ---------- 啟動模擬世界與伺服器 ----------
const world = await startWorld();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-ui-"));
const port = 21000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(here, "..", "server.js")], {
  env: { ...process.env, PORT: String(port), STUDIO_DATA_DIR: dataDir, ANTHROPIC_BASE_URL: world.claude.base, ANTHROPIC_API_KEY: "", SCHOLAR_ELSEVIER_BASE: world.scholar.url + "/els", SCHOLAR_CROSSREF_BASE: world.scholar.url + "/cr", SCHOLAR_OPENALEX_BASE: world.scholar.url + "/oa" },
  stdio: "ignore",
});
for (let i = 0; i < 50; i++) {
  try {
    await fetch(BASE + "/api/meta");
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}

const browser = await chromium.launch();
const consoleErrors = [];
async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 }, acceptDownloads: true, ...opts });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => consoleErrors.push(`[pageerror] ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/favicon/.test(m.text()) && consoleErrors.push(`[console] ${m.text()}`));
  page.setDefaultTimeout(20000);
  return page;
}
const statusDone = (sel) => (p) => p.waitForFunction((s) => /✅|❌|⏹|已停止/.test(document.querySelector(s)?.textContent || ""), sel, { timeout: 30000 });

const p = await newPage();
await p.goto(BASE);

// ---------- 首頁與設定 ----------
await step("首頁：未設定金鑰時顯示提示", async () => {
  assert(await p.isVisible("#setup-banner"), "應顯示設定提示");
  await p.screenshot({ path: path.join(SHOTS, "01-home.png") });
});

for (const [label, setup] of [
  ["Claude", async () => {
    await p.selectOption("#s-provider", "anthropic");
    await p.fill("#s-akey", "sk-ant-test");
    await p.selectOption("#s-cmodel", "claude-opus-5-5");
  }],
  ["OpenAI 相容", async () => {
    await p.selectOption("#s-provider", "openai");
    await p.fill("#s-okey", "sk-test");
    await p.fill("#s-obase", world.openai.base);
    await p.fill("#s-omodel", "mock");
  }],
]) {
  await step(`設定：${label} 測試連線成功、金鑰遮罩顯示`, async () => {
    await p.click("[data-tab=settings]");
    await setup();
    await p.fill("#s-webhook", world.webhook.url);
    await p.selectOption("#s-cache", "0");
    await p.click("#s-test");
    await p.waitForFunction(() => /✅|❌/.test(document.querySelector("#s-status").textContent));
    const st = await p.textContent("#s-status");
    assert(st.includes("✅"), st);
    const shown = await p.inputValue(label === "Claude" ? "#s-akey" : "#s-okey");
    assert(shown.includes("•"), "儲存後金鑰應遮罩：" + shown);
    assert(await p.locator("#key-dot.on").count(), "右上角應顯示已設定");
  });
}
await p.screenshot({ path: path.join(SHOTS, "02-settings.png"), fullPage: true });

// ---------- 檔案庫：上傳各種檔案 ----------
await step("檔案：一次上傳多種格式，掃描檔與空白檔顯示錯誤提示", async () => {
  await p.click("[data-tab=files]");
  const names = ["中文報告.pdf", "會議紀錄.docx", "報價單.docx", "庫存.xlsx", "名單.csv", "筆記.md", "說明.txt", "頁面.html", "掃描檔.pdf", "空白.txt"];
  const toasts = [];
  const watcher = setInterval(async () => {
    const t = await p.textContent("#toast").catch(() => "");
    if (t && !toasts.includes(t)) toasts.push(t);
  }, 50);
  await p.setInputFiles("#lib-upload", names.map((n) => path.join(FILES, n)));
  await p.waitForFunction(() => document.querySelectorAll("#lib-list .item").length >= 8, null, { timeout: 30000 });
  await p.waitForTimeout(800);
  clearInterval(watcher);
  const listed = await p.locator("#lib-list .item").count();
  assert(listed === 8, `應有 8 個成功的檔案，實際 ${listed}`);
  assert(toasts.some((t) => /掃描|OCR/.test(t)), "掃描檔應提示：" + toasts.join(" | "));
  assert(toasts.some((t) => /空/.test(t)), "空白檔應提示：" + toasts.join(" | "));
  await p.screenshot({ path: path.join(SHOTS, "03-files.png") });
});

// ---------- 文件工具：每個工具 × 每種來源 ----------
const docRun = async (src, tool, fill) => {
  await p.click("[data-tab=docs]");
  await p.click(`[data-src=${src}]`);
  await p.click(`[data-tool=${tool}]`);
  await fill();
  await p.click("#doc-run");
  await statusDone("#doc-status")(p);
  const st = await p.textContent("#doc-status");
  assert(st.includes("✅"), st);
  return st;
};
await step("文件工具：上傳 PDF → 轉 Markdown（不需 AI）", async () => {
  const st = await docRun("upload", "convert", () => p.setInputFiles("#doc-file", path.join(FILES, "中文報告.pdf")));
  assert((await p.textContent("#doc-output")).includes("營收成長百分之二十三"), "內容錯誤");
  assert(await p.locator("#doc-files a").count(), "應有下載連結");
  assert(st.includes("未使用 AI"), st);
});
await step("文件工具：檔案庫的 Word → 翻譯成英文，顯示 AI 用量", async () => {
  const st = await docRun("library", "translate", async () => {
    await p.selectOption("#doc-lib", { label: "會議紀錄.docx" });
    await p.selectOption("#doc-lang", "en");
  });
  assert((await p.textContent("#doc-output")).includes("【譯文】"), "沒有譯文");
  assert(/AI 呼叫 1 次/.test(st), "應顯示用量：" + st);
});
await step("文件工具：網址 → 摘要（會議紀錄風格）", async () => {
  await docRun("url", "summarize", async () => {
    await p.fill("#doc-url", world.site.url + "/about");
    await p.selectOption("#doc-style", { index: 2 });
  });
  assert((await p.textContent("#doc-output")).includes("AI 回覆"));
});
await step("文件工具：貼上文字 → 擷取表格，產生 Excel 與 CSV", async () => {
  await docRun("text", "extract", async () => {
    await p.fill("#doc-text", "烏龍茶 350 元，紅茶 280 元");
    await p.fill("#doc-fields", "品名, 價格");
  });
  const links = await p.locator("#doc-files a").allTextContents();
  assert(links.some((l) => l.includes(".xlsx")) && links.some((l) => l.includes(".csv")), links.join(","));
  const dl = p.waitForEvent("download");
  await p.locator("#doc-files a", { hasText: ".xlsx" }).click();
  const d = await dl;
  assert(d.suggestedFilename().endsWith(".xlsx"), "下載檔名：" + d.suggestedFilename());
  await p.screenshot({ path: path.join(SHOTS, "04-docs.png"), fullPage: true });
});

// ---------- 網站工具 ----------
await step("網站檢測：分數、問題清單、各項卡片、AI 建議", async () => {
  await p.click("[data-tab=web]");
  await p.click("[data-web=check]");
  await p.fill("#web-url", world.site.url);
  await p.click("#web-run");
  await statusDone("#web-status")(p);
  assert((await p.textContent("#web-status")).includes("✅"), await p.textContent("#web-status"));
  assert((await p.locator("#ck-grid .panel").count()) === 7, "應有 7 張卡片");
  await p.click("#ck-advise");
  await p.waitForFunction(() => document.querySelector("#ck-ai .markdown")?.textContent.includes("AI 回覆"));
  await p.screenshot({ path: path.join(SHOTS, "05-web-check.png"), fullPage: true });
});
await step("擷取網頁：Big5 編碼的網頁顯示正確中文", async () => {
  await p.click("[data-web=scrape]");
  await p.fill("#web-url", world.site.url + "/big5");
  await p.click("#web-run");
  await statusDone("#web-status")(p);
  assert((await p.textContent("#web-result")).includes("圖書館將於十二月一日"), "Big5 解碼錯誤");
});
await step("擷取網頁：被擋的網站顯示可行的解法", async () => {
  await p.fill("#web-url", world.site.url + "/blocked");
  await p.click("#web-run");
  await statusDone("#web-status")(p);
  assert(/拒絕程式直接存取/.test(await p.textContent("#web-status")), await p.textContent("#web-status"));
});

// ---------- 知識庫 ----------
await step("知識庫：建立 → 加入檔案、網頁、文字 → 提問 → 出處與用量", async () => {
  await p.click("[data-tab=kb]");
  await p.fill("#kb-new-name", "客服資料");
  await p.click("#kb-new");
  await p.waitForSelector("#kb-file");
  await p.setInputFiles("#kb-file", path.join(FILES, "說明.txt"));
  await p.click("#kb-add-file");
  await p.waitForFunction(() => document.querySelectorAll(".kb-docs .item").length === 1);
  await p.fill("#kb-url", world.site.url + "/");
  await p.click("#kb-add-url");
  await p.waitForFunction(() => document.querySelectorAll(".kb-docs .item").length === 2);
  await p.fill("#kb-text", "會員可享九折優惠。");
  await p.click("#kb-add-text");
  await p.waitForFunction(() => document.querySelectorAll(".kb-docs .item").length === 3);
  await p.fill("#kb-q", "退貨期限是幾天？");
  await p.keyboard.press("Enter");
  await p.waitForSelector(".msg.ai .src");
  const ans = await p.textContent(".msg.ai:last-child");
  assert(ans.includes("七天 [1]"), ans);
  assert(ans.includes("AI 呼叫 1 次"), "應顯示用量：" + ans);
  await p.click(".msg.ai .src summary");
  await p.screenshot({ path: path.join(SHOTS, "06-kb.png"), fullPage: true });
});
await step("知識庫：問不在資料裡的問題，誠實回答沒有", async () => {
  await p.fill("#kb-q", "老闆的名字？");
  await p.click("#kb-ask");
  await p.waitForFunction(() => document.querySelectorAll(".msg.ai").length >= 2 && !document.querySelector("#kb-ask").disabled);
  assert((await p.locator(".msg.ai").last().textContent()).includes("沒有相關資訊"));
});

// ---------- 工作流：每一個範本從介面執行 ----------
const meta = await (await fetch(BASE + "/api/meta")).json();
const templateInputs = {
  外文文章: { input: world.site.url + "/en" },
  論文: { file: "中文報告.pdf" },
  每日簡報: { input: [world.site.url + "/news/1", world.site.url + "/news/2"].join("\n"), webhook: true },
  健康巡檢: { input: world.site.url, webhook: true },
  變動監控: { input: world.site.url + "/changing", webhook: true, twice: true },
  Excel: { file: "報價單.docx" },
  知識庫: { input: world.site.url + "/docs/", kb: "客服資料" },
  "API 資料": { input: "demo/repo", patchUrl: world.site.url + "/api/issues" },
};
for (const [i, tpl] of meta.templates.entries()) {
  const key = Object.keys(templateInputs).find((k) => tpl.name.includes(k));
  const cfg = templateInputs[key];
  await step(`工作流範本（介面操作）：${tpl.name}`, async () => {
    assert(cfg, "測試沒有涵蓋這個範本，請補上");
    await p.click("[data-tab=flows]");
    await p.click(`[data-tpl="${i}"]`);
    await p.waitForSelector("#fl-input");
    // 依需要在介面上選擇檔案、知識庫、開啟通知節點、修改網址
    if (cfg.file || cfg.kb || cfg.patchUrl) {
      const node = p.locator(".node").first();
      await node.locator(".nhead").click();
      if (cfg.file) await node.locator("select[data-k=fileId]").selectOption({ label: cfg.file });
    }
    if (cfg.kb) {
      const n = p.locator(".node", { has: p.locator("select[data-k=kbId]") });
      if (!(await n.evaluate((el) => el.classList.contains("open")))) await n.locator(".nhead").click();
      await n.locator("select[data-k=kbId]").selectOption({ label: cfg.kb });
    }
    if (cfg.patchUrl) await p.locator("input[data-k=url]").first().fill(cfg.patchUrl);
    if (cfg.webhook) await p.locator(".node.disabled [data-op=toggle]").click();
    if (cfg.input) await p.fill("#fl-input", cfg.input);
    const hooks = world.webhook.received.length;
    const runOnce = async () => {
      await p.click("#fl-run");
      await statusDone("#fl-status")(p);
      return p.textContent("#fl-status");
    };
    let st = await runOnce();
    if (cfg.twice) {
      assert(st.includes("⏹"), "第一次應只記錄基準：" + st);
      st = await runOnce();
    }
    assert(st.includes("✅"), st);
    assert(!(await p.locator(".node.error").count()), "有節點失敗");
    if (cfg.webhook) assert(world.webhook.received.length === hooks + 1, "應送出一則通知");
    const out = await p.textContent("#fl-output");
    for (const bad of ["undefined", "[object Object]", "{{"]) assert(!out.includes(bad), `輸出含「${bad}」`);
    await p.screenshot({ path: path.join(SHOTS, `07-flow-${i}.png`), fullPage: true });
  });
}

await step("工作流編輯器：新增節點、上下移動、停用、匯出、刪除", async () => {
  await p.click("#flow-new");
  await p.waitForSelector("#fl-nodes .node");
  await p.click("summary:has-text('新增節點')");
  await p.click("[data-add=fetch_url]");
  await p.click("[data-add=save_file]");
  assert((await p.locator("#fl-nodes .node").count()) === 3, "應有 3 個節點");
  await p.locator("#fl-nodes .node").nth(1).locator("[data-op=up]").click();
  const first = await p.locator("#fl-nodes .node .ntitle").first().textContent();
  assert(first.includes("擷取網頁"), "上移失敗：" + first);
  await p.locator("#fl-nodes .node").nth(2).locator("[data-op=toggle]").click();
  assert(await p.locator("#fl-nodes .node.disabled").count(), "停用失敗");
  const dl = p.waitForEvent("download");
  await p.click("#fl-export");
  assert((await dl).suggestedFilename().endsWith(".json"));
  p.once("dialog", (d) => d.accept());
  await p.click("#fl-del");
  await p.waitForFunction(() => document.querySelector("#flow-panel").textContent.includes("已刪除"));
});

await step("首頁：最近執行與產出檔案、AI 用量統計", async () => {
  await p.click("[data-tab=home]");
  await p.waitForSelector("#home-runs .item");
  assert((await p.locator("#home-outputs .item").count()) > 0);
  await p.click("[data-tab=settings]");
  await p.waitForSelector("#usage-box div");
  const usage = await p.textContent("#usage-box");
  assert(/今天\d/.test(usage.replace(/[,\s]/g, "")), usage);
});

// ---------- 深色模式與手機寬度 ----------
for (const [label, opts] of [
  ["深色模式", { colorScheme: "dark" }],
  ["手機寬度 390px", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }],
]) {
  await step(`${label}：每個分頁都能顯示、沒有橫向捲動`, async () => {
    const m = await newPage(opts);
    await m.goto(BASE);
    for (const tab of ["home", "flows", "kb", "docs", "web", "files", "settings"]) {
      await m.click(`[data-tab=${tab}]`);
      await m.waitForTimeout(250);
      const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert(overflow <= 1, `${tab} 頁面橫向超出 ${overflow}px`);
      await m.screenshot({ path: path.join(SHOTS, `08-${label}-${tab}.png`), fullPage: true });
    }
    await m.context().close();
  });
}

await step("整個過程沒有任何 JavaScript 錯誤", async () => {
  assert(!consoleErrors.length, consoleErrors.slice(0, 5).join("\n"));
});

await browser.close();
server.kill();
world.close();
console.log(`\n${results.length - failures} 通過，${failures} 失敗。截圖：${SHOTS}`);
process.exit(failures ? 1 : 0);
