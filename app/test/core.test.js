import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog, searchCatalog, parseMarkdown, parseRepoFromUrl, toSimplified } from "../lib/catalog.js";
import { render, runWorkflow, PRESET_WORKFLOWS } from "../lib/workflows.js";
import { extractJson } from "../lib/llm.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const catalog = loadCatalog(ROOT);

test("解析所有年度目錄", () => {
  assert.ok(catalog.length > 3000, `only ${catalog.length}`);
  const years = new Set(catalog.map((p) => p.year));
  for (const y of [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025]) assert.ok(years.has(y), `missing ${y}`);
  assert.ok(catalog.every((p) => p.name && p.url && p.description && p.category));
});

test("解析單列 Markdown 與 repo", () => {
  const md = "## 2099 年复盘\n### 工具\n项目|简述\n---|---\n[foo](https://github.com/a/b)|一个 <b>好</b> 工具 ![x](y)\n";
  const items = parseMarkdown(md, 2099);
  assert.equal(items.length, 1);
  assert.equal(items[0].repo, "a/b");
  assert.equal(items[0].description, "一个 好 工具");
  assert.equal(parseRepoFromUrl("https://github.com/topics/ai"), null);
});

test("繁體搜尋可找到簡體內容", () => {
  assert.equal(toSimplified("影片剪輯"), "影片剪辑");
  const r = searchCatalog(catalog, "視頻剪輯", { limit: 5 });
  assert.ok(r.length > 0);
  assert.ok(r.some((p) => /视频|剪辑/.test(p.description)));
});

test("模板變數替換", () => {
  const out = render("A={{input}} B={{steps.x}} C={{missing}}", { vars: { input: "hi" }, steps: { x: "ok" } });
  assert.equal(out, "A=hi B=ok C=");
});

test("extractJson", () => {
  assert.deepEqual(extractJson('好的：\n```json\n[{"id":1}]\n```'), [{ id: 1 }]);
  assert.equal(extractJson("no json"), null);
});

test("內建流程結構正確", () => {
  for (const w of PRESET_WORKFLOWS) {
    assert.ok(w.key && w.name && w.steps.length);
    for (const s of w.steps) assert.ok(["search", "pick", "ai_select", "github", "filter", "llm"].includes(s.type));
  }
});

test("搜尋 + 篩選流程（免 API）可執行", async () => {
  const events = [];
  const { output } = await runWorkflow(
    { steps: [{ type: "search", query: "{{input}}", limit: 5 }, { type: "filter", minYear: 2024 }] },
    { input: "爬虫", catalog, emit: (e) => events.push(e) },
  );
  assert.ok(events.some((e) => e.type === "done"));
  assert.match(output, /\[/);
});

test("pick 支援外部 owner/repo", async () => {
  const { ctx } = await runWorkflow({ steps: [{ type: "pick", ids: "{{input}}" }] }, { input: "someone/somerepo", catalog });
  assert.equal(ctx.projects[0].repo, "someone/somerepo");
});

test("LLM 步驟在沒有金鑰時給出明確錯誤", async () => {
  await assert.rejects(
    runWorkflow({ steps: [{ type: "llm", prompt: "hi" }] }, { input: "x", catalog, llm: { provider: "anthropic", apiKey: "" } }),
    /API Key/,
  );
});
