# Coze 节点结构源码对照分析（coze-studio 开源版 vs 私有平台）

> 分析日期：2026-08-14
> 源码：https://github.com/coze-dev/coze-studio（backend/domain/workflow/）
> 对照基准：docs/coze-platform/health-workflow-103-nosnack-sample.json（真实平台样本）
> ⚠️ 注意：开源源码与 dev1.dachensky.com 私有平台的 schema 格式**有差异**，
> 私有平台以实际抓包样本为准，源码用于理解语义和字段含义。

---

## 一、源码关键常量（权威数值）

### 1. 选择器（condition/selector）端口命名 — `internal/schema/branch_schema.go`

```go
PortDefault      = "default"       // 否则/else 分支
PortBranchError  = "branch_error"  // 异常分支
PortBranchFormat = "branch_%d"     // 条件分支：branch_0, branch_1...
```

**但私有平台 validate_tree 报错显示端口是 `true` / `true_1` / `true_2` / `false`**
（因为私有平台 operator=11 布尔为真时，端口名绑定 operator 语义）。
→ **端口命名以平台实测为准**：N 个分支 = `true`, `true_1`, ..., `true_(N-1)`，else = `false`。

### 2. 运算符枚举 — `entity/vo/canvas.go`

```go
type OperatorType int
const (
    _ = iota            // 0
    Equal = 1           // "="
    NotEqual = 2        // "!="
    LengthGreaterThan = 3
    LengthGreaterThanEqual = 4
    LengthLessThan = 5
    LengthLessThanEqual = 6
    Contain = 7
    NotContain = 8
    Empty = 9
    NotEmpty = 10
    True = 11           // 布尔为真（我们当前用的）
    False = 12
    GreaterThan = 13    // ">"
    GreaterThanEqual = 14
    LessThan = 15
    LessThanEqual = 16
)
```

### 3. 逻辑类型 — `canvas.go`

```go
type LogicType int
const (
    _ LogicType = iota
    OR   // 1
    AND  // 2  ← 我们用 2 正确
)
```

### 4. 结束节点 — `canvas.go`

```go
type TerminatePlan string
const (
    ReturnVariables  = "returnVariables"   // 返回变量
    UseAnswerContent = "useAnswerContent"  // 用答案内容
)
```

### 5. 错误处理 — `canvas.go`

```go
type ErrorProcessType int
const (
    ErrorProcessTypeThrow             = 1  // 抛出错误
    ErrorProcessTypeReturnDefaultData = 2  // 返回兜底数据
    ErrorProcessTypeExceptionBranch   = 3  // 走异常分支
)
```

---

## 二、节点结构对照结论

### ✅ 已确认正确（源码 + 样本一致）

| 节点 | 结构 | 说明 |
|------|------|------|
| start (1) | `outputs: [{type:string, name:input, required:false}]` + `trigger_parameters: []` | entry 节点要求 id=100001；outputs 可多字段（后续优化） |
| end (2) | `inputs: {terminatePlan, inputParameters}`，**无 outputs** | 平台不允许 end 加 outputs |
| llm (3) | `inputs: {inputParameters, llmParam, settingOnError}` + `outputs` + `version:"3"` | outputs 需含内置字段（见下） |
| code (5) | `inputs: {inputParameters, code, language, settingOnError}` + `outputs` | language 3=Python/1=JS |
| condition (8) | `inputs: {branches}`，**无 outputs** | 只有 branches 结构 |
| merge (32) | `inputs: {mergeGroups}` + `outputs` | mergeGroups[].variables 是 BlockInput（{type,value}）不带 name |
| database (43) | `inputs: {databaseInfoList, selectParam, settingOnError}` + `outputs` | DatabaseInfoID 是字符串；conditionList 是 `[][]*Param` 嵌套数组 |
| text (15) | `inputs: {method, inputParameters, concatParams}` + `outputs` | concat 模式需 concatResult + arrayItemConcatChar |

### ✅ 已修复（2026-08-14）

| 问题 | 修复 |
|------|------|
| LLM 节点缺 outputs（保存失败） | createLLMNode 默认 `[{type:string,name:output}]` + generator 用 contract.outputs 覆盖 |
| LLM outputs 缺内置字段 | 补 `reasoning_content` / `errorBody`(object+schema 数组+readonly) / `isSuccess`(boolean+readonly) |
| llmParam 4 个无用字段 | 删 generationDiversity/apiType/supportThinking/enableThinking（源码忽略） |
| HTTP 节点结构全错 | 从 `{method,url,headers,body}` 改为源码真实结构 `{apiInfo:{method,url}, body:{bodyType,bodyData}, headers:[], params:[], auth:{authType}, setting:{}}` |
| text concatParams 缺 arrayItemConcatChar | 补默认空字符串 |
| modelType 写死 201 | 改为动态传入 modelTypeMap（save.tool 拉 get_model_list 构建） |
| condition left 引用写死 start | 改为引用上游节点输出 |
| condition 端口命名 | true/true_1/true_2/false（平台实测） |

### ⚠️ 待验证（需要用户从私有平台复制节点样本）

以下节点**只对照了开源源码，未对照私有平台实际格式**，需要真实样本：

1. ~~**database (43)**~~ ✅ **已确认（2026-08-14 用户提供样本）**：
   结构与生成完全一致——databaseInfoList/logic AND/orderByList/limit/settingOnError/outputs 全对；
   conditionList 嵌套数组结构对，内容为空正常（无查询条件时）；
   有条件时格式：`[[{name:"left",input:{type:string,value:literal content:set_id}}, {name:"operation",input:{...content:EQUAL}}, {name:"right",input:{...ref blockID:200102 name:recipe_set_id}}]]`
2. ~~**http (45)**~~ ✅ **已确认+修复（2026-08-14 用户提供样本 161311）**：
   平台真实结构与源码推断有 4 处差异，已修正——
   body.bodyType="EMPTY"（大写，不是 "none"）；bodyData.binary.fileURL（ref 空）;
   auth={authType:"BEARER_AUTH", authData:{customData:{addTo:"header"}}, authOpen:false}（不是 no_auth）;
   setting={timeout:120(秒), retryTimes:3}（字段名 retryTimes 不是 retry，无 isStreaming）;
   outputs=body/statusCode/headers（不是 response）
3. ~~**text (15) 完整 concatParams**~~ ✅ **已确认+修复（2026-08-14 用户提供样本 1287269）**：
   concat 模式需三个参数——concatResult + arrayItemConcatChar + allArrayItemConcatChars
   （list 类型，schema={type:object, schema:[label/value/isDefault 均 required]}，
   value 默认 6 个分隔符：换行/制表符/句号/逗号/分号/空格）；已照抄实现
4. ~~**start (1) 多输入**~~ ✅ **已确认+实现（2026-08-14 用户提供样本）**：
   平台 start outputs 支持多字段（examination_report/questionnaireData/personal_requirement），
   list 类型带 schema:{type:string}，可选参数带 defaultValue。已实现：
   LLM startInputs → planner contract → generator inputVariables → converter outputs
   （含 list schema + defaultValue）
5. ~~**code (5) outputs schema 细节**~~ ✅ **已确认（2026-08-14 用户提供样本 200102）**：
   outputs 基础类型（string/boolean/integer）不带 schema 字段；object 带 schema=[]；
   list 带 schema={type:string} 或 {type:object,schema:[]}——当前实现已正确，无需修改
6. ~~**llm (3) 完整 llmParam**~~ ✅ **已确认+修复（2026-08-14 用户提供样本 141264）**：
   ⚠️ **重要教训：开源源码说 generationDiversity/apiType/supportThinking/enableThinking 被忽略，
   但私有平台样本显示这 4 个字段存在（14 项齐全）！之前根据源码删了它们，已恢复。
   以后删字段必须以平台样本为准，不能只看源码。**
   settingOnError 结构也修正：{switch:true, dataOnErr(json字符串), processType:3, timeoutMs:120000,
   singleTimeoutMs:0, retryTimes:1, ext:{backupLLmParam(json字符串)}}

---

## 三、本次修改文件清单（未提交）

```
apps/api/src/coze/schema-converter.ts   ← LLM outputs 内置字段 + llmParam 清理 + HTTP 结构 + text arrayItemConcatChar
```

---

## 四、待用户提供样本清单

从企业 Coze 平台复制以下节点 JSON（编辑器里复制节点 → 剪贴板 JSON）：

- [ ] HTTP 请求节点（type 45）
- [ ] 查询数据节点（type 43，带真实查询条件）
- [ ] 文本处理节点（type 15，concat 模式）
- [ ] 开始节点（type 1，多输入参数）
- [ ] 代码节点（type 5，带 list/object 输出）
- [ ] 大模型节点（type 3，完整 llmParam + outputs）
- [ ] 变量聚合节点（type 32，多组变量）
