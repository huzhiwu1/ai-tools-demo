/**
 * upload-store - 上传文件登记表（模块级单例）
 *
 * 职责：记录 fileId → { 磁盘路径, 文件名 } 的映射
 *
 * 关键细节：
 * - 上传接口在保存文件后写入映射，resume 时按 fileId 还原文件名与磁盘路径，
 *   拼入消息让 LLM 感知文件并用 read_file 直接读取
 * - dev watch 模式热载会清空映射（内存态），属可接受的演示行为
 */

/** 单个上传文件的登记信息 */
export interface UploadedFileRecord {
  /** 文件在服务器上的磁盘路径 */
  path: string;
  /** 原始文件名（已还原中文编码） */
  name: string;
}

export const uploadPathStore = new Map<string, UploadedFileRecord>();
