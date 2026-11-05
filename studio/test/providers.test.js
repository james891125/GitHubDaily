// AI 供應商、模型清單、設定相容性、各種檔案格式
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startStack, FILES } from "./helpers.js";
import { findSoffice } from "../lib/formats.js";

let S;
before(async () => {
  S = await startStack();
});
after(() => S?.close());

describe("AI 供應商", () => {
  const cases = [
    ["openai", { openaiKey: "sk-openai", openaiModel: "gpt-test-chat" }, "Bearer sk-openai"],
    ["openrouter", { openrouterKey: "sk-or-test", openrouterModel: "vendor/vision-model" }, "Bearer sk-or-test"],
    ["gemini", { geminiKey: "gm-test", geminiModel: "gemini-test-flash" }, "Bearer gm-test"],
    ["deepseek", { deepseekKey: "ds-test", deepseekModel: "deepseek-chat" }, "Bearer ds-test"],
    ["groq", { groqKey: "gsk-test", groqModel: "llama-test" }, "Bearer gsk-test"],
  ];
  for (const [id, fields, auth] of cases) {
    test(`${id}：連線測試成功，使用該供應商自己的金鑰與模型`, async () => {
      await S.api("/api/settings", { provider: id, cacheDays: 0, ...fields });
      const r = await S.api("/api/settings/test", {});
      assert.equal(r.ok, true, r.error);
      const last = S.world.openai.calls.at(-1);
      assert.equal(last.model, Object.values(fields)[1]);
    });
  }
  test("OpenRouter 會帶上識別標頭（HTTP-Referer、X-Title）", async () => {
    await S.api("/api/settings", { provider: "openrouter" });
    await S.api("/api/models?provider=openrouter");
    const req = S.world.openai.media.filter((m) => m.path?.endsWith("/models")).at(-1);
    assert.equal(req.headers["x-title"], "AI Office Platform");
    assert.equal(req.headers.authorization, "Bearer sk-or-test");
  });
  test("各家金鑰分開保存：切換供應商不會遺失其他家的金鑰與模型", async () => {
    await S.api("/api/settings", { provider: "gemini" });
    await S.api("/api/settings", { provider: "deepseek" });
    const s = await S.api("/api/settings");
    for (const k of ["openaiKey", "openrouterKey", "geminiKey", "deepseekKey", "groqKey"]) assert.ok(s[k].includes("•"), `${k} 應保留`);
    assert.equal(s.geminiModel, "gemini-test-flash");
    assert.equal(s.openrouterModel, "vendor/vision-model");
  });
  test("Ollama（本機）不需要金鑰", async () => {
    await S.api("/api/settings", { provider: "ollama", ollamaBase: S.world.openai.base, ollamaModel: "ollama-test" });
    const meta = await S.api("/api/meta");
    assert.equal(meta.ready, true);
    const r = await S.api("/api/settings/test", {});
    assert.equal(r.ok, true, r.error);
  });
  test("未填金鑰、未選模型時有清楚提示", async () => {
    await S.api("/api/settings", { provider: "openrouter", openrouterKey: "", openrouterModel: "" });
    let r = await S.api("/api/settings/test", {});
    assert.match(r.error, /尚未設定 OpenRouter 的 API Key/);
    await S.api("/api/settings", { openrouterKey: "sk-or-test" });
    r = await S.api("/api/settings/test", {});
    assert.match(r.error, /尚未選擇 OpenRouter 的模型.*取得模型清單/);
    await S.api("/api/settings", { openrouterModel: "vendor/vision-model" });
  });
  test("所有金鑰在設定 API 中都經過遮罩", async () => {
    const s = await S.api("/api/settings");
    const text = JSON.stringify(s);
    for (const secret of ["sk-openai", "sk-or-test", "gm-test", "ds-test", "gsk-test"]) assert.ok(!text.includes(secret), secret);
  });
  test("PDF 文字辨識：OpenAI／OpenRouter 以 file 格式送出 PDF", async () => {
    await S.api("/api/settings", { provider: "openrouter" });
    const f = await S.upload("掃描檔.pdf");
    const ev = await S.stream("/api/services/run", { id: "ocr", form: { file: f.id } });
    assert.equal(ev.filter((e) => e.type === "done").at(-1)?.status, "success", JSON.stringify(ev.at(-2)));
    const content = S.world.openai.calls.at(-1).messages.at(-1).content;
    assert.equal(content[1].type, "file");
    assert.match(content[1].file.file_data, /^data:application\/pdf;base64,/);
  });
  test("PDF 文字辨識：Gemini 無法讀 PDF 時提示改用其他供應商", async () => {
    await S.api("/api/settings", { provider: "gemini" });
    const f = await S.upload("掃描檔.pdf");
    const ev = await S.stream("/api/services/run", { id: "ocr", form: { file: f.id } });
    assert.match(ev.find((e) => e.type === "error").message, /Google Gemini 無法直接讀取 PDF/);
  });
  test("網路搜尋只在 Claude 可用", async () => {
    await S.api("/api/settings", { provider: "openrouter" });
    const ev = await S.stream("/api/services/run", { id: "web-research", form: { question: "測試" } });
    assert.match(ev.find((e) => e.type === "error").message, /需要使用 Claude/);
  });
});

describe("模型清單（從 API 取得）", () => {
  test("OpenRouter：顯示名稱、上下文、可輸入類型、每百萬 tokens 價格", async () => {
    const { models } = await S.api("/api/models?provider=openrouter&purpose=chat");
    const v = models.find((m) => m.id === "vendor/vision-model");
    assert.equal(v.name, "Vendor: Vision Model");
    assert.equal(v.context, 200000);
    assert.deepEqual(v.input, ["text", "image", "file"]);
    assert.deepEqual(v.price, { input: 3, output: 15 });
    assert.ok(!models.some((m) => m.id === "vendor/image-gen"), "生圖模型不應出現在文字模型清單");
    assert.ok(!models.some((m) => /embedding|whisper/.test(m.id)), "嵌入與語音模型不應出現在文字模型清單");
  });
  test("依用途篩選：語音轉文字、圖片生成", async () => {
    const speech = (await S.api("/api/models?provider=openrouter&purpose=speech")).models.map((m) => m.id);
    assert.ok(speech.includes("whisper-1") && speech.includes("vendor/audio-model"), speech.join());
    const image = (await S.api("/api/models?provider=openrouter&purpose=image")).models.map((m) => m.id);
    assert.ok(image.includes("gpt-image-1") && image.includes("vendor/image-gen"), image.join());
  });
  test("Gemini：去除 models/ 前綴", async () => {
    const { models } = await S.api("/api/models?provider=gemini");
    assert.ok(models.some((m) => m.id === "gemini-test-flash"));
  });
  test("Claude：透過官方 SDK 取得", async () => {
    await S.api("/api/settings", { anthropicKey: "sk-ant-test" });
    const { models } = await S.api("/api/models?provider=anthropic");
    assert.deepEqual(models.map((m) => m.id), ["claude-haiku-5-5", "claude-opus-5-5"]);
    assert.equal(models.find((m) => m.id === "claude-opus-5-5").context, 1000000);
  });
  test("未填金鑰時提示；Ollama 未啟動時提示", async () => {
    await S.api("/api/settings", { deepseekKey: "" });
    await assert.rejects(S.api("/api/models?provider=deepseek"), /請先填寫 DeepSeek 的 API Key/);
    await S.api("/api/settings", { ollamaBase: "http://127.0.0.1:1/v1" });
    await assert.rejects(S.api("/api/models?provider=ollama"), /請確認 Ollama 已啟動/);
  });
});

describe("設定相容性", () => {
  test("舊版設定（OpenAI 相容 + 自訂網址）自動轉為「其他 OpenAI 相容服務」", async () => {
    const file = path.join(S.dataDir, "settings.json");
    fs.writeFileSync(file, JSON.stringify({ provider: "openai", openaiKey: "old-key-123456789", openaiBase: S.world.openai.base, openaiModel: "mock", anthropicKey: "sk-ant-test" }));
    const s = await S.api("/api/settings");
    assert.equal(s.provider, "custom");
    assert.equal(s.customBase, S.world.openai.base);
    assert.equal(s.customModel, "mock");
    assert.ok(s.customKey.includes("•"));
    assert.equal(s.openaiKey, "");
    const r = await S.api("/api/settings/test", {});
    assert.equal(r.ok, true, r.error);
  });
});

describe("檔案格式", () => {
  const expect = {
    "簡報.pptx": [/## 第 2 張投影片/, /\| 感測器 \| 12000 \|/, /講者備註：.*強調節能成效/],
    "簡報.odp": [/## 第 1 張投影片/, /\| 雲端服務 \| 3600 \|/],
    "會議紀錄.odt": [/決議：下週三前完成報價/],
    "會議紀錄.doc": [/決議：下週三前完成報價/],
    "會議紀錄.rtf": [/會議紀錄\n決議：下週三前完成報價/],
    "庫存.ods": [/## 工作表：資料/, /\| 鍵盤 \| 12 \|/],
    "電子書.epub": [/^# 校園導覽/, /第一章 行政大樓[\s\S]*第二章 圖書館/],
    "會議通知.eml": [/^# 會議通知：系務會議/, /寄件者：office@example\.edu\.tw/, /11 月 20 日下午兩點/, /## 附件[\s\S]*agenda\.txt/],
    "字幕.srt": [/^大家好，歡迎參加說明會。\n今天介紹選課流程。$/],
    "字幕.vtt": [/^大家好，歡迎參加說明會。\n今天介紹選課流程。$/],
  };
  for (const [name, res] of Object.entries(expect)) {
    test(`讀取 ${name}`, async () => {
      const f = await S.upload(name);
      const r = await S.api("/api/doc/convert", { fileId: f.id });
      for (const re of res) assert.match(r.text, re);
      assert.ok(!/<number>|undefined/.test(r.text));
    });
  }
  const soffice = findSoffice();
  for (const [name, re] of [["簡報.ppt", /\| 感測器 \| 12000 \|/], ["庫存.xls", /\| 滑鼠 \| 30 \|/]]) {
    test(`讀取舊版 ${name}（透過 LibreOffice）`, { skip: soffice ? false : "此電腦未安裝 LibreOffice" }, async () => {
      const f = await S.upload(name);
      const r = await S.api("/api/doc/convert", { fileId: f.id });
      assert.match(r.text, re);
    });
  }
  test("Outlook .msg：說明如何另存為 .eml", async () => {
    await assert.rejects(S.api("/api/files", { name: "信件.msg", data: Buffer.from("x").toString("base64") }), /另存新檔」為 \.eml/);
  });
  test("損毀的 PowerPoint 檔：清楚的錯誤", async () => {
    await assert.rejects(S.api("/api/files", { name: "壞掉.pptx", data: Buffer.from("not a zip").toString("base64") }), /無法讀取PowerPoint 檔/);
  });
  test("音檔與圖片可上傳到檔案庫（標記需轉錄／需文字辨識）", async () => {
    const a = await S.upload("錄音.wav");
    assert.equal(a.kind, "audio");
    assert.equal(a.needsTranscribe, true);
    const i = await S.upload("截圖.png");
    assert.equal(i.needsOcr, true);
  });
});
