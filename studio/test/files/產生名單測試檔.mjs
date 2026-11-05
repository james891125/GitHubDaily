// 產生名單比對測試檔：全班名單.xlsx 與 已繳交名單.csv
// 已繳交名單刻意包含：全形學號、多餘空白、英文大小寫不同、重複繳交、Email 改過、不在全班名單的旁聽生。
// 執行：node test/files/產生名單測試檔.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";

const here = path.dirname(fileURLToPath(import.meta.url));
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("全班");
ws.addRow(["學號", "姓名", "系所", "Email"]);
const students = [
  ["B11001", "王小明", "河海工程學系", "b11001@mail.edu.tw"],
  ["B11002", "李美華", "河海工程學系", "b11002@mail.edu.tw"],
  ["B11003", "陳志強", "資訊工程學系", "b11003@mail.edu.tw"],
  ["B11004", "林怡君", "資訊工程學系", "b11004@mail.edu.tw"],
  ["B11005", "張家豪", "河海工程學系", "b11005@mail.edu.tw"],
];
students.forEach((s) => ws.addRow(s));
await wb.xlsx.writeFile(path.join(here, "全班名單.xlsx"));
const csv = [
  "學號,姓名,Email,繳交時間",
  "Ｂ１１００１,王小明,b11001@mail.edu.tw,2026/11/01 10:00",
  " b11003 ,陳志強,B11003@MAIL.EDU.TW,2026/11/02 09:30",
  "B11004,林怡君,yijun@gmail.com,2026/11/02 11:00",
  "B11004,林怡君,yijun@gmail.com,2026/11/03 08:00",
  "A99001,旁聽生,guest@example.com,2026/11/03 12:00",
].join("\r\n");
fs.writeFileSync(path.join(here, "已繳交名單.csv"), "﻿" + csv);
console.log("ok");
