/**
 * [Tool] get_platform_facts - 平台事实查询
 *
 * 职责：
 * 向 LLM 提供 Coze 平台真实可用能力清单（模型 / 数据库 / 节点类型），
 * 防止 LLM 生成节点时臆造不存在的模型（如 gpt-4o）、无效数据源或错误节点类型。
 *
 * 流程：
 * 1. 模型列表 → 通过 CozeClient.listModels() 实时查询 API
 * 2. 数据库列表 → 通过 CozeClient.listDatabases() 实时查询 API
 * 3. 节点类型 → 静态数据（平台版本升级才会变，且无权威查询接口）
 *
 * 关键细节：
 * - 模型：audio=true 表示支持音频理解（音频/视频任务必须选 audio=true 的）
 * - 数据库：resId 即 database 节点的 databaseInfoID
 * - 节点类型列表是 node_template_list 全量实测，与 schema-converter 映射一致
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { cozeClient } from "./coze-client";

/** 节点类型静态数据：平台版本升级才会变，无需动态查询 */
const NODE_TYPES = [
  { type: "1", name: "开始", desc: "工作流起始节点", category: "输入&输出" },
  {
    type: "2",
    name: "结束",
    desc: "返回工作流运行结果",
    category: "输入&输出",
  },
  { type: "3", name: "大模型", desc: "调用大语言模型", category: "核心" },
  {
    type: "4",
    name: "插件",
    desc: "访问实时数据和外部操作",
    category: "核心",
  },
  {
    type: "5",
    name: "代码",
    desc: "处理输入变量生成返回值",
    category: "业务逻辑",
  },
  {
    type: "6",
    name: "知识库检索",
    desc: "知识库召回",
    category: "知识库&数据",
  },
  { type: "8", name: "选择器", desc: "多分支条件判断", category: "业务逻辑" },
  { type: "9", name: "工作流", desc: "嵌套子任务", category: "核心" },
  {
    type: "12",
    name: "SQL自定义",
    desc: "自定义 SQL 增删改查",
    category: "数据库",
  },
  {
    type: "13",
    name: "输出",
    desc: "中间过程消息输出",
    category: "输入&输出",
  },
  {
    type: "15",
    name: "文本处理",
    desc: "字符串变量格式处理",
    category: "组件",
  },
  {
    type: "16",
    name: "图像生成",
    desc: "文字/参考图生成图片",
    category: "图像处理",
  },
  { type: "18", name: "问答", desc: "中间向用户提问", category: "组件" },
  { type: "19", name: "终止循环", desc: "跳出循环体", category: "业务逻辑" },
  {
    type: "20",
    name: "设置变量",
    desc: "重置循环变量",
    category: "业务逻辑",
  },
  { type: "21", name: "循环", desc: "循环执行任务", category: "业务逻辑" },
  { type: "22", name: "意图识别", desc: "意图匹配", category: "业务逻辑" },
  {
    type: "27",
    name: "知识库写入",
    desc: "添加文本知识库",
    category: "知识库&数据",
  },
  { type: "28", name: "批处理", desc: "批量运行任务", category: "业务逻辑" },
  {
    type: "29",
    name: "继续循环",
    desc: "终止当前循环执行下次",
    category: "业务逻辑",
  },
  {
    type: "30",
    name: "输入",
    desc: "中间过程信息输入",
    category: "输入&输出",
  },
  { type: "31", name: "注释", desc: "注释", category: "组件" },
  {
    type: "32",
    name: "变量聚合",
    desc: "多分支输出聚合",
    category: "业务逻辑",
  },
  {
    type: "40",
    name: "变量赋值",
    desc: "给变量赋值",
    category: "知识库&数据",
  },
  { type: "42", name: "更新数据", desc: "修改表数据", category: "数据库" },
  { type: "43", name: "查询数据", desc: "查询表数据", category: "数据库" },
  { type: "44", name: "删除数据", desc: "删除表数据", category: "数据库" },
  { type: "45", name: "HTTP请求", desc: "发送 API 请求", category: "组件" },
  { type: "46", name: "新增数据", desc: "插入表数据", category: "数据库" },
  {
    type: "58",
    name: "JSON序列化",
    desc: "变量转 JSON 字符串",
    category: "组件",
  },
  {
    type: "59",
    name: "JSON反序列化",
    desc: "JSON 字符串解析为变量",
    category: "组件",
  },
  {
    type: "61",
    name: "火山知识库检索",
    desc: "火山外部知识库",
    category: "知识库&数据",
  },
  { type: "1001", name: "延迟定时器", desc: "延迟执行", category: "定时器" },
  { type: "1002", name: "单次定时器", desc: "定时执行", category: "定时器" },
  {
    type: "1100",
    name: "企微私聊群发",
    desc: "企微私聊触达",
    category: "触达",
  },
  { type: "1101", name: "AI外呼", desc: "外呼触达", category: "触达" },
  { type: "1102", name: "发送短信", desc: "短信触达", category: "触达" },
  { type: "1103", name: "企微群", desc: "企微群聊触达", category: "触达" },
  { type: "1104", name: "企微朋友圈", desc: "朋友圈内容", category: "触达" },
  {
    type: "1105",
    name: "企微朋友圈评论",
    desc: "朋友圈评论",
    category: "触达",
  },
  {
    type: "1200",
    name: "引用标签",
    desc: "引用既有标签",
    category: "标签管理",
  },
  {
    type: "1300",
    name: "生成人工任务",
    desc: "人工处理任务",
    category: "AI运营",
  },
];

export const getPlatformFactsTool = tool(
  async ({ spaceId }) => {
    // 并行查询模型和数据库（其中一个失败不阻塞另一个）
    const [models, databases] = await Promise.allSettled([
      cozeClient.listModels(spaceId),
      cozeClient.listDatabases(spaceId),
    ]);

    // 上下文瘦身（2026-08-16）：输出越紧凑，主 LLM 上下文压力越小
    // 1) nodeTypes 去掉 category（LLM 选节点类型用 type/name/desc 足够）
    // 2) 整体用紧凑 JSON（无缩进），减少空白 token
    const result: Record<string, unknown> = {
      nodeTypes: NODE_TYPES.map(({ category: _category, ...rest }) => rest),
      _meta: { source: "real-time" },
    };

    if (models.status === "fulfilled") {
      // 瘦身：只保留 LLM 选模型需要的字段（name/modelType/audio/image/video），
      // 防御性 map：即使底层 listModels 未来加字段也不透出给 LLM
      result.models = models.value.map((m) => ({
        name: m.name,
        modelType: m.modelType,
        audio: m.audio,
        image: m.image,
        video: m.video,
      }));
    } else {
      result.models = [];
      result._warning_models = `模型列表查询失败：${models.reason?.message ?? "未知错误"}`;
    }

    if (databases.status === "fulfilled") {
      result.databases = databases.value;
    } else {
      result.databases = [];
      result._warning_databases = `数据库列表查询失败：${databases.reason?.message ?? "未知错误"}`;
    }

    return JSON.stringify(result);
  },
  {
    name: "get_platform_facts",
    description:
      "获取 Coze 平台真实可用能力清单：模型列表（含 audio 音频理解能力标记）、" +
      "数据库列表（resId）、节点类型列表。" +
      "生成工作流前建议先调用本工具确认可用的模型和数据源：" +
      "LLM 节点模型必须从 models 列表选择（音频任务选 audio=true 的）；" +
      "database 节点必须用 databases 里的 resId；节点类型从 nodeTypes 选择。",
    schema: z.object({
      spaceId: z.string().optional().describe("目标空间 ID（缺省用 .env 的 COZE_SPACE_ID）"),
    }),
  },
);