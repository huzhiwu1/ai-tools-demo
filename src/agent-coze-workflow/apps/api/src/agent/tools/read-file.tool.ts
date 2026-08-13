/**
 * [Tool] read_file - 通用文件读取
 *
 * 职责：
 * 将用户上传的文件读成通用数据结构，不做任何业务假设。
 * 表格类文件（xlsx/xls/csv）→ 行列数据；文本类文件（md/txt/json）→ 文本内容。
 * 文件用途、列含义、数据怎么用 —— 全部由 LLM 根据用户需求判断。
 *
 * 流程：
 * 1. 按扩展名分派解析器
 * 2. 表格类：xlsx 库读第一个 sheet，第 1 行作表头，后续行转 {列名: 值}
 * 3. 文本类：fs.readFileSync 读全文
 * 4. 返回通用 JSON 结构（含 fileName、fileType、format、数据等）
 *
 * 关键细节：
 * - 零业务假设：不翻译列名、不推断列含义、不剥离任何前缀
 * - 空行跳过（计入 skippedEmptyRows），行内空单元格值为 null
 * - try/catch 兜底，错误以字符串返回给 LLM
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as XLSX from "xlsx";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

/** 表格类扩展名 */
const TABLE_EXTENSIONS = new Set([".xlsx", ".xls", ".csv"]);

/**
 * 判断文件扩展名是否为表格类
 */
function isTableFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return TABLE_EXTENSIONS.has(ext);
}

/**
 * 解析表格文件（xlsx/xls/csv）
 *
 * 第 1 行作表头，后续行转 {列名: 值} 对象。
 * 空行跳过（计入 skippedEmptyRows），行内空单元格值为 null。
 */
function parseTable(filePath: string): object {
  const ext = path.extname(filePath).toLowerCase();
  // CSV 是纯文本：先按 UTF-8 读入再交给 SheetJS 解析，避免 readFile
  // 按 latin1 读导致中文乱码（同时剥离 BOM）；xlsx/xls 是二进制格式，必须用 readFile
  const workbook =
    ext === ".csv"
      ? XLSX.read(fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, ""), {
          type: "string",
        })
      : XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  // raw: false 用 formatted 值，defval: null 空单元格为 null
  const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    raw: false,
    defval: null,
  });

  const columns = data.length > 0 ? Object.keys(data[0]) : [];

  const rows: Array<Record<string, unknown>> = [];
  let skippedEmptyRows = 0;
  for (const row of data) {
    const isEmpty = columns.every((col) => {
      const val = row[col];
      return val === null || val === undefined || String(val).trim() === "";
    });
    if (isEmpty) {
      skippedEmptyRows++;
    } else {
      rows.push(row);
    }
  }

  return {
    fileName: path.basename(filePath),
    fileType: path.extname(filePath).replace(".", ""),
    format: "table",
    columns,
    rows,
    totalRows: rows.length,
    skippedEmptyRows,
  };
}

/**
 * 解析文本文件（md/txt/json 等）
 */
function parseText(filePath: string): object {
  const content = fs.readFileSync(filePath, "utf-8");
  return {
    fileName: path.basename(filePath),
    fileType: path.extname(filePath).replace(".", "") || "txt",
    format: "text",
    content,
  };
}

export const readFileTool = tool(
  async ({ filePath }) => {
    try {
      if (!fs.existsSync(filePath)) {
        return `读取失败: 文件不存在 - ${filePath}`;
      }

      if (isTableFile(filePath)) {
        return JSON.stringify(parseTable(filePath), null, 2);
      }

      return JSON.stringify(parseText(filePath), null, 2);
    } catch (e) {
      return `读取失败: ${(e as Error).message}`;
    }
  },
  {
    name: "read_file",
    description:
      "通用文件读取工具，返回文件原始内容。支持表格文件（xlsx/xls/csv）和文本文件（md/txt/json）。" +
      "表格文件返回列名（columns）和行数据（rows），文本文件返回全文内容（content）。" +
      "文件的具体用途、列的含义、数据如何参与工作流，由你（LLM）根据用户需求判断；" +
      "如果无法判断，调用 clarify_question 向用户询问。",
    schema: z.object({
      filePath: z
        .string()
        .describe("上传文件接口返回的 path 字段（文件在服务器上的绝对路径）"),
    }),
  },
);
