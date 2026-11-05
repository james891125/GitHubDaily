// 測試共用：啟動模擬世界與真正的伺服器，並提供 API 呼叫工具
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { startWorld } from "./world.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FILES = path.join(here, "files");

export async function startStack({ env = {} } = {}) {
  const world = await startWorld();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-it-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const BASE = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [path.join(here, "..", "server.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      STUDIO_DATA_DIR: dataDir,
      ANTHROPIC_BASE_URL: world.claude.base,
      ANTHROPIC_API_KEY: "",
      SCHOLAR_ELSEVIER_BASE: world.scholar.url + "/els",
      SCHOLAR_CROSSREF_BASE: world.scholar.url + "/cr",
      SCHOLAR_OPENALEX_BASE: world.scholar.url + "/oa",
      ARXIV_BASE: world.scholar.url + "/arxiv",
      // 所有 OpenAI 相容供應商都指向模擬服務
      PROVIDER_BASE_OPENAI: world.openai.base,
      PROVIDER_BASE_OPENROUTER: world.openai.base,
      PROVIDER_BASE_GEMINI: world.openai.base,
      PROVIDER_BASE_DEEPSEEK: world.openai.base,
      PROVIDER_BASE_GROQ: world.openai.base,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(BASE + "/api/meta");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
      if (i === 59) throw new Error("伺服器啟動失敗：" + log);
    }
  }
  const api = async (p, body, method) => {
    const res = await fetch(BASE + p, { method: method || (body ? "POST" : "GET"), headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error), { status: res.status });
    return data;
  };
  const stream = async (p, body) => {
    const res = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  };
  const upload = (name) => api("/api/files", { name, data: fs.readFileSync(path.join(FILES, name)).toString("base64") });
  const uploadBuf = (name, buf) => api("/api/files", { name, data: Buffer.from(buf).toString("base64") });
  const download = async (file) => Buffer.from(await (await fetch(BASE + file.url)).arrayBuffer());
  return { world, BASE, api, stream, upload, uploadBuf, download, dataDir, close: () => (server.kill(), world.close()) };
}

export const last = (events, type) => events.filter((e) => e.type === type).at(-1);

/** 輸出內容不得出現程式錯誤的痕跡 */
export function cleanCheck(assert, text, where) {
  for (const bad of ["undefined", "[object Object]", "{{", "NaN"]) assert.ok(!String(text).includes(bad), `${where} 出現「${bad}」：${String(text).slice(0, 300)}`);
}

/** 產生 n 頁、每頁印有頁碼的測試 PDF */
export async function makePdf(n, label = "Page", width = 595) {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= n; i++) d.addPage([width, 842]).drawText(`${label} ${i}`, { x: 50, y: 780, size: 24, font });
  return Buffer.from(await d.save());
}

/** 產生雙欄英文論文 PDF（標題、摘要、雙欄內文、公式、圖、頁碼、參考文獻），測試對照翻譯 */
export async function makePaper(pages = 2) {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.TimesRoman);
  const bold = await d.embedFont(StandardFonts.TimesRomanBold);
  const words = "The meshless method avoids mesh generation and provides accurate solutions for groundwater flow problems in heterogeneous porous media with complex boundaries".split(" ");
  const para = (k, n) => Array.from({ length: n }, (_, i) => words[(i + k) % words.length]).join(" ") + ".";
  const wrap = (text, f, size, width) => {
    const lines = [];
    let line = "";
    for (const w of text.split(" ")) {
      const t = line ? line + " " + w : w;
      if (f.widthOfTextAtSize(t, size) > width) lines.push(line), (line = w);
      else line = t;
    }
    if (line) lines.push(line);
    return lines;
  };
  for (let p = 1; p <= pages; p++) {
    const page = d.addPage([595, 842]);
    let top = 790;
    if (p === 1) {
      page.drawText("Meshless Methods for Groundwater Flow", { x: 140, y: top, size: 18, font: bold });
      top -= 40;
      for (const l of wrap("Abstract. " + para(3, 40), font, 10, 495)) page.drawText(l, { x: 50, y: top, size: 10, font }), (top -= 12.5);
      top -= 20;
    }
    for (const [ci, x] of [50, 310].entries()) {
      let y = top;
      page.drawText(`${p}.${ci + 1} Section heading`, { x, y, size: 12, font: bold });
      y -= 20;
      for (let k = 0; k < 3; k++) {
        for (const l of wrap(para(p * 7 + ci * 3 + k, 45), font, 10, 235)) page.drawText(l, { x, y, size: 10, font }), (y -= 12.5);
        y -= 10;
        if (ci === 0 && k === 0) {
          page.drawText("u ( x , t ) = a x + b t + c", { x: x + 40, y, size: 10, font }), (y -= 22);
        }
      }
      if (ci === 1 && p === 1) {
        page.drawRectangle({ x, y: y - 100, width: 235, height: 90, borderColor: { type: "RGB", red: 0, green: 0, blue: 0 }, borderWidth: 1, color: { type: "RGB", red: 0.85, green: 0.9, blue: 1 } });
      }
    }
    if (p === pages) {
      page.drawText("References", { x: 310, y: 230, size: 12, font: bold });
      page.drawText("[1] Iverson, R. M. (1997). The physics of debris flows.", { x: 310, y: 212, size: 9, font });
    }
    page.drawText(String(p), { x: 295, y: 30, size: 9, font });
  }
  return Buffer.from(await d.save());
}
