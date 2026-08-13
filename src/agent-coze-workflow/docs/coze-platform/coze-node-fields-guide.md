# Coze 平台节点字段参考（健康食养工作流实测样本）

> 来源：`health-workflow-103-nosnack-sample.json`（2026-08-12 用户提供，21 节点 / 25 边，6 种节点类型）
> 用途：schema-converter 生成器的目标格式基准。此前样本只覆盖 LLM/人工任务，此样本补齐代码/选择器/文本处理/变量聚合/查询数据。

## 0. 剪贴板数据顶层结构

```jsonc
{
  "type": "coze-workflow-clipboard-data",
  "source": { "workflowId": "...", "flowMode": 0, "spaceId": "...", "isDouyin": false, "host": "coze.dachensky.com" },
  "json": {
    "nodes": [ /* 节点数组 */ ],
    "edges": [ /* 边数组 */ ]
  }
}
```

- 注意：此样本无 `versions: {loop:"v2"}`（之前样本有），说明该字段非必填
- `start`（100001）与 `end`（900001 等）不在 nodes 里，但被 `block-output` 引用——start 输出如 `examination_report/questionnaireData`

### 边的两种形态

```jsonc
// 无端口（代码节点出边，铁律：不写 sourcePortID）
{ "sourceNodeID": "182549", "targetNodeID": "141264" }
// 带端口（LLM 节点异常分支 / 选择器 true/false）
{ "sourceNodeID": "141264", "targetNodeID": "1287269", "sourcePortID": "branch_error" }
{ "sourceNodeID": "169974", "targetNodeID": "1930343", "sourcePortID": "true" }
```

## 1. 节点通用骨架

```jsonc
{
  "id": "182549",           // 字符串数字
  "type": "5",              // 字符串数字
  "meta": { "position": { "x": ..., "y": ... } },
  "data": {
    "nodeMeta": { "title", "icon", "description", "mainColor", "subTitle" },
    "inputs": { /* 类型各异 */ },
    "outputs": [ /* 输出声明 */ ],
    // 部分节点还有：version("3" LLM)、settingOnError
  },
  "_temp": {                // 剪贴板/画布展示专用，API 创建可省略
    "bounds": { "x", "y", "width", "height" },
    "externalData": { "icon", "description", "title", "mainColor" }
  }
}
```

### 值引用语法（数据流核心）

```jsonc
// 引用上游节点输出
{ "type": "ref", "content": { "source": "block-output", "blockID": "100001", "name": "examination_report" }, "rawMeta": { "type": 99 } }
// 字面量
{ "type": "literal", "content": "0.2", "rawMeta": { "type": 4 } }
// rawMeta.type 对照：1=string, 2=integer, 3=boolean, 4=float, 6=object, 99=list(string), 103=list(object), 104=vision list
```

## 2. 节点类型分布与字段清单

### type=3 大模型（5 个，200101/200104A/200104B/141264/1930343）

- `data.inputs.inputParameters[]`：业务输入，`{ name, input: {type, schema?, value: ref} }`
- `data.inputs.llmParam[]`：14 项参数（顺序不固定）：
  - temperature(float, literal "0.2~0.3") / maxTokens(integer) / topP(float "0.7"/"0.95")
  - responseFormat(integer "2"=JSON) / modleName(string，注意拼写 modle) / modelType(integer "180"/"200"/"201"/"260")
  - generationDiversity("balance"/"default_val") / supportThinking / enableThinking(boolean)
  - apiType(integer "1") / prompt(string，{{变量}} 模板) / enableChatHistory(false) / chatHistoryRound("3")
  - systemPrompt(string，角色/目标/限制/输出格式 json)
- `data.inputs.settingOnError`（失败兜底）：
  ```jsonc
  {
    "switch": true,
    "dataOnErr": "{json 字符串，含字段兜底值}",   // 注意：转义了两层（\\\"）
    "processType": 3,          // 3=走异常分支, 1=用兜底数据
    "timeoutMs": 120000, "singleTimeoutMs": 0, "retryTimes": 1,
    "ext": { "backupLLmParam": "{json 字符串，备份模型参数}" }
  }
  ```
- `data.outputs`：业务字段 + 内置 `reasoning_content` + `errorBody`(object, readonly) + `isSuccess`(boolean, readonly)
- `data.version`: "3"

### type=5 代码（8 个，182549/105094/200102/200105/200106/200107/200108/200201）

```jsonc
"inputs": {
  "inputParameters": [ { "name", "input": { "type", "schema"?, "value": ref } } ],
  "code": "async def main(args: Args) -> Output:\n ...",
  "language": 3,                       // 3=Python
  "settingOnError": { "processType": 1, "timeoutMs": 60000, "retryTimes": 0 }
}
"outputs": [ { "type": "string"|"object"|"list", "name": "...", "schema": ... } ]
```

- 代码内 `params = args.params` 取输入；`ret: Output = {...}` 返回（与 outputs 声明一致）
- 代码节点**出边不写 sourcePortID**（铁律，见 memory/2026-08-04）
- 常见防御模式（本工作流实战沉淀）：
  - 输入兼容：`if isinstance(x, str): json.loads(x)`（上游 object 序列化成字符串传入）
  - `{"items": [...]}` 包装解包：`if isinstance(x, dict): x = x.get("items") or []`
  - 输出结构白名单：下游只取需要的 key，多余字段一律过滤（200106 四餐白名单）

### type=8 选择器（3 个，169974/200105b/200105c）

```jsonc
"inputs": {
  "branches": [ {
    "condition": {
      "logic": 2,                      // 2=AND
      "conditions": [ {
        "operator": 11,                // 11=布尔为真（is true）
        "left": { "input": { "type": "boolean", "value": { "type": "ref", "content": { "source": "block-output", "blockID": "200105", "name": "is_success" } } } }
      } ]
    }
  } ]
}
```

- 出边：`true` / `false` 端口
- 没有 `outputs`

### type=15 文本处理（3 个，127375/1287269/1428331）

```jsonc
"inputs": {
  "method": "concat",                  // 拼接模式
  "inputParameters": [ { "name": "String1", "input": { "type": "string", "value": ref } } ],
  "concatParams": [
    { "name": "concatResult", "input": { "type": "string", "value": { "type": "literal", "content": "{{String1}}", "rawMeta": {"type":1} } } },
    { "name": "arrayItemConcatChar", "input": { "type": "string", "value": { "type": "literal", "content": "，", "rawMeta": {"type":1} } } },
    { "name": "allArrayItemConcatChars", "input": { "type": "list", "schema": {...label/value/isDefault...}, "value": { "type": "literal", "content": [{label:"换行",value:"\n",isDefault:true}, ...] } } }
  ]
}
"outputs": [ { "type": "string", "name": "output", "required": true } ]
```

- 模板语法 `{{String1}}` 引用 inputParameters 里的变量
- 常用来拼 error_message（"模型节点超时" / "食谱生成失败（失败天数：{{String2}}）"）

### type=32 变量聚合（1 个，102441）

```jsonc
"inputs": {
  "mergeGroups": [ {
    "name": "Group1",
    "variables": [ { "type": "string", "value": { "type": "ref", "content": { "source": "block-output", "blockID": "1428331", "name": "output" }, "rawMeta": {"type":1} } } ]
  } ]
}
"outputs": [ { "type": "string", "name": "Group1" } ]
```

- 作用：把多个分支（错误路径）的输出聚合到一个变量，供下游 end/error 节点使用
- group name 与 outputs name 一致

### type=43 查询数据（1 个，197436）

```jsonc
"inputs": {
  "databaseInfoList": [ { "databaseInfoID": "7668315009742569472" } ],
  "selectParam": {
    "condition": {
      "conditionList": [ [ { "name": "left", "input": {"type":"string","value":{"type":"literal","content":"set_id"}} },
                           { "name": "operation", "input": {"type":"string","value":{"type":"literal","content":"EQUAL"}} },
                           { "name": "right", "input": {"type":"string","value": ref(recipe_set_id)} } ],
                         [ /* AND 条件第二条：version = v1 */ ] ],
      "logic": "AND"
    },
    "orderByList": [],
    "limit": 100
  },
  "settingOnError": { "processType": 1, "timeoutMs": 60000, "retryTimes": 0 }
}
"outputs": [ { "type": "list", "name": "outputList", "schema": {"type":"object","schema":[]} }, { "type": "integer", "name": "rowNum" } ]
```

- conditionList 内层数组元素固定三个 name：left / operation / right
- 查询结果 outputList 供下游代码节点按 day_no 排序

## 3. 本工作流的架构范式（健康食养 28 天）

```
start(100001: examination_report/questionnaireData/personal_requirement)
→ [182549 无图处理(code)] → [141264 输出是否接待(llm)] → [169974 判断是否接待(selector)]
   ├─ true → [1930343 体检报告解读生成(llm)] → [105094 解析体检报告分析(code)]
   │          → [200101 问卷信息结构化(llm)] → [200102 食谱套系路由(code)]
   │          → [197436 查询数据(db)] → [200201 排序28天基础食谱(code)]
   │          → [200104A 生成28天单日食谱(llm, 批处理)] → [200105 校验单日食谱(code)]
   │          → [200105b 校验分支(selector)]
   │             ├─ true → [200106 整理28天结果(code)] → end(result)
   │             └─ false → [200107 筛选失败天(code)] → [200104B 重生成失败天食谱(llm)]
   │                       → [200108 合并复检(code)] → [200105c 最终校验分支(selector)]
   │                          ├─ true → [200106 整理28天结果]
   │                          └─ false → [1428331 error_msg：生成失败]
   └─ false → [127375 error_msg：不接待输出]
   [1287269 error_msg：模型超时] ← LLM 节点的 branch_error 边
   三个 error → [102441 变量聚合 error_msg] → end(error_message)
```

- 失败重试闭环：批处理生成 → 校验 → 筛选失败天 → 局部重生成 → 合并复检 → 最终校验
- 幂等关键：`day_no` 一律以批处理序号/失败天号为准（不信 LLM 输出），dayLabel 交叉校验正则提取数字比对
- 输出结构白名单在最后一跳（200106）兜底，保证 result.weeks[].days[].meals 恒定四餐

## 4. 与项目内其他样本的差异提示

- 之前 `coze-llm-node-sample.json`（flowMode=2，dev1 环境）有 `versions:{loop:"v2"}`；本样本（flowMode=0）没有 → 生成器不应强制要求该字段
- 本样本 host 是 `coze.dachensky.com`（生产），之前是 `coze.dev1.dachensky.com`
- `modleName` 是平台原始拼写（拼写错误），生成器沿用即可
