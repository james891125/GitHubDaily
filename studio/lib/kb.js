// 個人知識庫：文件切塊 + 本地 BM25 檢索（中英文皆可，不需要 Embedding API）+ AI 問答附出處
import { load, save, remove, newId } from "./store.js";
import { chunkText } from "./docs.js";
import { generate } from "./llm.js";

/** 斷詞：英數取單字，中日韓文取單字與雙字 */
export function tokenize(text) {
  const s = String(text || "").toLowerCase();
  const tokens = [];
  for (const m of s.matchAll(/[a-z0-9][a-z0-9_.-]*/g)) if (m[0].length > 1 || /\d/.test(m[0])) tokens.push(m[0]);
  for (const run of s.match(/[぀-ヿ㐀-鿿가-힯]+/g) || []) {
    for (let i = 0; i < run.length; i++) {
      tokens.push(run[i]);
      if (i < run.length - 1) tokens.push(run.slice(i, i + 2));
    }
  }
  return tokens;
}

const STOP = new Set(["的", "了", "是", "在", "和", "與", "及", "或", "the", "and", "of", "to", "a", "in", "is", "for", "on", "what", "how", "什", "麼", "什麼", "如何", "嗎", "呢", "請", "問"]);

function kbIndex() {
  return load("kb-index", []);
}
function kbFile(id) {
  return `kb-${id}`;
}

export function listKbs() {
  return kbIndex();
}

export function getKb(id) {
  const kb = load(kbFile(id), null);
  if (!kb) throw Object.assign(new Error("找不到此知識庫"), { status: 404 });
  return kb;
}

function saveKb(kb) {
  save(kbFile(kb.id), kb);
  const idx = kbIndex().filter((k) => k.id !== kb.id);
  idx.unshift({ id: kb.id, name: kb.name, description: kb.description, docs: kb.docs.length, chunks: kb.chunks.length, updatedAt: new Date().toISOString() });
  save("kb-index", idx);
}

export function createKb(name, description = "") {
  const kb = { id: newId(), name: name || "未命名知識庫", description, docs: [], chunks: [], createdAt: new Date().toISOString() };
  saveKb(kb);
  return kb;
}

export function deleteKb(id) {
  save("kb-index", kbIndex().filter((k) => k.id !== id));
  remove(kbFile(id));
}

export function addDocument(kbId, { title, text, source = "", kind = "text" }) {
  const kb = getKb(kbId);
  const docId = newId();
  const chunks = chunkText(text).map((c) => ({ id: `${docId}:${c.index}`, docId, heading: c.heading, text: c.text, tf: termFreq(c.text + " " + c.heading + " " + title) }));
  if (!chunks.length) throw new Error("文件沒有可用的文字內容");
  kb.docs.push({ id: docId, title, source, kind, chars: text.length, chunks: chunks.length, addedAt: new Date().toISOString() });
  kb.chunks.push(...chunks);
  saveKb(kb);
  return { docId, chunks: chunks.length };
}

export function removeDocument(kbId, docId) {
  const kb = getKb(kbId);
  kb.docs = kb.docs.filter((d) => d.id !== docId);
  kb.chunks = kb.chunks.filter((c) => c.docId !== docId);
  saveKb(kb);
}

function termFreq(text) {
  const tf = {};
  let len = 0;
  for (const t of tokenize(text)) {
    tf[t] = (tf[t] || 0) + 1;
    len++;
  }
  tf.__len = len;
  return tf;
}

/** BM25 檢索 */
export function search(kb, query, k = 6) {
  const q = [...new Set(tokenize(query))].filter((t) => !STOP.has(t));
  if (!q.length || !kb.chunks.length) return [];
  const N = kb.chunks.length;
  const avg = kb.chunks.reduce((s, c) => s + (c.tf.__len || 0), 0) / N || 1;
  const df = {};
  for (const t of q) df[t] = kb.chunks.reduce((n, c) => n + (c.tf[t] ? 1 : 0), 0);
  const k1 = 1.4;
  const b = 0.75;
  const scored = kb.chunks.map((c) => {
    let s = 0;
    for (const t of q) {
      const f = c.tf[t];
      if (!f) continue;
      const idf = Math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5));
      // 雙字詞與英文詞比單字更有鑑別力
      const w = t.length >= 2 ? 1.5 : 0.6;
      s += w * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * (c.tf.__len || 0)) / avg)));
    }
    return { c, s };
  });
  const docTitle = Object.fromEntries(kb.docs.map((d) => [d.id, d.title]));
  const ranked = scored.filter((x) => x.s > 0).sort((a, b2) => b2.s - a.s);
  // 相關度遠低於第一名的段落對回答幫助不大，卻會增加 token，直接略過
  const floor = (ranked[0]?.s || 0) * 0.3;
  return ranked
    .filter((x) => x.s >= floor)
    .slice(0, k)
    .map(({ c, s }) => ({ id: c.id, docId: c.docId, title: docTitle[c.docId], heading: c.heading, text: c.text, score: Math.round(s * 100) / 100 }));
}

/**
 * 問答：檢索 → 讓 LLM 依據資料回答並標註 [1] [2] 出處
 * history: [{role, content}]（最近幾輪對話，用來理解追問）
 */
export async function ask(kbId, question, { history = [], k = 5, onText = () => {}, signal } = {}) {
  const kb = getKb(kbId);
  // 追問時把上一題一併納入檢索
  const lastUser = [...history].reverse().find((m) => m.role === "user")?.content || "";
  let hits = search(kb, question, k);
  if (hits.length < 3 && lastUser) hits = search(kb, lastUser + " " + question, k);
  const sources = hits.map((h, i) => ({ n: i + 1, ...h }));
  const context = sources.length
    ? sources.map((s) => `[${s.n}] 《${s.title}》${s.heading ? "／" + s.heading : ""}\n${s.text}`).join("\n\n---\n\n")
    : "（知識庫中沒有找到相關內容）";
  const system = `你是知識庫「${kb.name}」的問答助理。只能根據提供的資料回答，使用繁體中文。
規則：
- 每個事實後面用 [編號] 標註出處，例如：營業時間是早上九點 [2]。
- 資料不足以回答時，直接說「知識庫中沒有相關資訊」，並說明缺少什麼，不要自行猜測或編造。
- 回答精簡、有條理，可用 Markdown 條列或表格。`;
  const messages = [
    // 只帶最近 2 輪對話（足以理解追問），避免每次重送整段歷史
    ...history.slice(-4).map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) })),
    { role: "user", content: `參考資料：\n\n${context}\n\n---\n\n問題：${question}` },
  ];
  const { text } = await generate({ system, messages, maxTokens: 8000 }, onText, signal);
  return { answer: text, sources };
}
