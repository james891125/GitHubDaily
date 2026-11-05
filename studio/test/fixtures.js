// 測試用：本機假網站 + 假的 OpenAI 相容 LLM + 產生 PDF
import http from "node:http";

export function startSite() {
  const pages = {
    "/": `<html lang="zh-Hant"><head><title>測試商店</title><meta name="description" content="測試用"><meta name="viewport" content="width=device-width"></head>
      <body><nav><a href="/about">關於</a> <a href="/products">產品</a> <a href="/missing">壞掉</a> <a href="https://other.example/">外站</a></nav>
      <h1>歡迎光臨</h1><article><p>${"本店販售各式手工茶葉，退貨期限為七天。".repeat(12)}</p></article><img src="a.png"></body></html>`,
    "/about": `<html><head><title>關於我們</title></head><body><article><h1>關於</h1><p>${"我們成立於 2010 年，總部位於台北市信義區。客服電話 02-1234-5678。".repeat(8)}</p></article></body></html>`,
    "/products": `<html><head><title>產品</title></head><body><h1>產品列表</h1><table><tr><th>品名</th><th>價格</th></tr><tr><td>烏龍茶</td><td>350</td></tr><tr><td>紅茶</td><td>280</td></tr></table><a href="/">首頁</a></body></html>`,
  };
  let changing = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/robots.txt") return res.end("User-agent: *\nAllow: /");
    if (req.url === "/changing") return res.end(`<html><body><h1>價格</h1><p>目前價格 ${100 + changing++} 元</p></body></html>`);
    const p = pages[req.url.split("?")[0]];
    if (!p) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff", "set-cookie": "sid=1; Path=/" });
    res.end(p);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

/** 假的 OpenAI 相容 LLM：依提示內容回覆可預測的答案 */
export function startMockLlm() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let b = "";
    for await (const c of req) b += c;
    const body = JSON.parse(b);
    const prompt = body.messages.map((m) => m.content).join("\n");
    calls.push(prompt);
    let out;
    if (prompt.includes('"columns"')) out = '```json\n{"columns":["品名","價格"],"rows":[{"品名":"烏龍茶","價格":"350"},{"品名":"紅茶","價格":"280"}]}\n```';
    else if (prompt.includes("翻譯成")) out = "【譯文】" + prompt.split("---\n").pop().slice(0, 50);
    else if (prompt.includes("參考資料")) out = /退貨/.test(prompt) && /七天/.test(prompt) ? "退貨期限是七天 [1]。" : "知識庫中沒有相關資訊";
    else out = "## 摘要\n\n- 重點一\n- 重點二";
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const ch of out.match(/[\s\S]{1,10}/g)) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, calls, base: `http://127.0.0.1:${server.address().port}/v1` })));
}

/** 產生一份含文字的最小 PDF（含正確 xref） */
export function makePdf(lines) {
  const content = "BT /F1 14 Tf 50 750 Td 18 TL " + lines.map((l) => `(${l}) Tj T*`).join(" ") + " ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}
