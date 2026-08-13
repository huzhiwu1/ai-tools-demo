/**
 * CodeGenerator - 代码节点 Python 代码生成器
 *
 * 职责：
 * 根据节点业务逻辑描述（PlanStep.nodeConfig.code.logicDescription），
 * 通过 DeepSeek LLM 生成符合 Coze 平台代码节点规范的 Python 代码，
 * 替换原来的"// TODO 占位注释"模板。
 *
 * 流程：
 * 1. 拼接平台代码规范 + 业务逻辑描述，调 DeepSeekClient.chatStructured
 * 2. zod schema { code: string } 约束输出
 * 3. 失败降级：返回可运行的兜底模板（echo input → output），不是空注释
 *
 * 关键细节：
 * - 平台代码节点规范（docs/coze-platform/coze-node-fields-guide.md）：
 *   入口函数 async def main(args: Args) -> Output:
 *   params = args.params 取输入
 *   ret: Output = {...} 返回，与 outputs 声明一致
 *   输入兼容：if isinstance(x, str): json.loads(x)
 * - 用户参考数据（如歌词库）由 LLM 写成代码内常量（如 SONG_LYRICS = {...}）
 * - LLM 失败不影响主流程（降级模板保证工作流可保存、可执行）
 */
import { z } from "zod";
import { Logger } from "@nestjs/common";
import type { DeepSeekClient } from "../llm/deepseek.client";

/** LLM 生成的代码输出 Schema */
const CodeOutputSchema = z.object({
  code: z.string().describe("完整的 Python 代码，符合 Coze 平台代码节点规范"),
});

/** 平台代码节点规范（嵌入生成 prompt，LLM 必须遵守） */
const CODE_SPEC_PROMPT = `你是 Coze 工作流代码节点 Python 代码生成器。
根据业务逻辑描述生成可执行的 Python 代码。

必须遵守 Coze 平台代码节点规范：
1. 入口函数：async def main(args: Args) -> Output:
2. params = args.params 取输入变量
3. ret: Output = {...} 返回，返回字段必须与 outputs 声明一致
4. 输入兼容：上游可能把 object 序列化成字符串传入，用 if isinstance(x, str): json.loads(x) 防御
5. 用户参考数据（如歌词库、歌曲列表）写成代码内常量（如 SONG_LYRICS = {...}）
6. 输出必须是 JSON 可序列化的数据
7. 只输出代码本身，不要任何解释`;

export class CodeGenerator {
  private readonly logger = new Logger("CodeGenerator");

  constructor(private readonly client: DeepSeekClient) {}

  /**
   * 根据业务逻辑描述生成平台规范的 Python 代码
   *
   * @param logicDescription - 业务逻辑描述（含阈值/数据常量/处理步骤）
   * @param inputs - 代码节点需要的输入变量名列表
   * @param referenceData - 用户参考数据（如歌词库），LLM 必须原样写入代码常量
   * @returns Python 代码字符串（LLM 失败时返回可运行的兜底模板）
   */
  async generateCode(
    logicDescription: string,
    inputs?: string[],
    referenceData?: Record<string, string>,
  ): Promise<string> {
    const dataHint =
      referenceData && Object.keys(referenceData).length > 0
        ? `用户参考数据（必须原样写入代码常量，不得修改、不得替换）：\n${JSON.stringify(referenceData, null, 2)}\n\n重要：参考数据中的歌曲库/歌词库/列表必须原样保留，禁止编造、替换或删减。`
        : "";

    const inputHint =
      inputs && inputs.length > 0
        ? `输入变量：${inputs.join(", ")}（通过 args.params 获取）`
        : "输入：args.params";

    try {
      const prompt = `${CODE_SPEC_PROMPT}\n\n${dataHint}\n业务逻辑：${logicDescription}\n${inputHint}`;
      const result = await this.client.chatStructured(
        CodeOutputSchema,
        CODE_SPEC_PROMPT,
        prompt,
      );
      if (result.code && result.code.trim()) {
        return result.code.trim();
      }
      // LLM 返回空代码：降级
      this.logger.warn("[CodeGenerator] LLM 返回空代码，使用兜底模板");
      return CodeGenerator.buildFallbackCode(inputs);
    } catch (e) {
      // LLM 调用失败：降级为可运行模板，不影响主流程
      this.logger.warn(
        `[CodeGenerator] 代码生成失败，使用兜底模板: ${(e as Error).message}`,
      );
      return CodeGenerator.buildFallbackCode(inputs);
    }
  }

  /**
   * 生成可运行的兜底代码模板（echo input → output）
   *
   * 不是 TODO 注释：这个模板本身能在平台上跑，保证保存后的工作流可执行。
   * 生成阶段失败不会导致 720701013 invalid syntax。
   */
  static buildFallbackCode(inputs?: string[]): string {
    const inputName = inputs?.[0] ?? "input";
    return `import json

async def main(args: Args) -> Output:
    params = args.params
    raw = params.get("${inputName}", "")
    if isinstance(raw, str) and raw:
        try:
            raw = json.loads(raw)
        except Exception:
            pass
    ret: Output = {"result": raw}
    return ret`;
  }
}
