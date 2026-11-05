// 測試共用：啟動模擬世界與真正的伺服器，並提供 API 呼叫工具
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startWorld } from "./world.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FILES = path.join(here, "files");

export async function startStack() {
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
  const download = async (file) => Buffer.from(await (await fetch(BASE + file.url)).arrayBuffer());
  return { world, BASE, api, stream, upload, download, dataDir, close: () => (server.kill(), world.close()) };
}

export const last = (events, type) => events.filter((e) => e.type === type).at(-1);

/** 輸出內容不得出現程式錯誤的痕跡 */
export function cleanCheck(assert, text, where) {
  for (const bad of ["undefined", "[object Object]", "{{", "NaN"]) assert.ok(!String(text).includes(bad), `${where} 出現「${bad}」：${String(text).slice(0, 300)}`);
}
