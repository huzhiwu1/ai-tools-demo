# Task: 加入 validate_tree 校验 + 修复 queryExecute 接口 + 修复条件分支多端口连线

## 背景

当前 agent 构建工作流时，AI 反复试错才发现平台约束（如条件分支端口未连接）。每次失败都是一次"保存 → 平台报错 → 反思 → 重试"的全链路往返，耗时且烧钱。

实测发现两个关键问题：
1. **`validate_tree` 接口** 可以在保存前就校验出节点连通性问题，但没被调用
2. **`queryExecute` 用的 `execute_detail`/`execute_info` 接口根本不存在**，导致 batch_validate 永远返回"执行结果查询接口未打通"
3. **条件分支有 N 个分支，但 generator 只创建 1 条边**，导致 N-1 个端口未连接

## 要求

### 1. CozeClient 新增 `validateTree()` 方法

**接口**：`POST /api/workflow_api/validate_tree`

**请求体**（走 `urlPrefix: "/api/workflow_api/"`，即默认 *coze.client.ts 的 `request` 方法已有的前缀*，注意不要多加 `/api`）：
```json
{
  "workflow_id": "string",
  "schema": "string"  // 平台内部 schema JSON 字符串（与 save 的 schema 参数一致）
}
```

**注意**：`validate_tree` 走 `/api/workflow_api/` 前缀，不是 `/api/` 前缀。也就是 `request()` 方法用默认的 `urlPrefix` 参数。

**响应**：
```json
{
  "code": 0,
  "msg": "",
  "data": [
    {
      "workflow_id": "string",
      "name": "string",
      "errors": [
        {
          "node_error": {
            "node_id": "string",
            "node_name": "string"
          },
          "path_error": null,
          "message": "node \"条件判断\"'s port \"true_1\" not connected;...",
          "type": 1
        }
      ]
    }
  ]
}
```

**类型定义**（在 `types.ts` 中新增）：
```typescript
export interface ValidateTreeRequest {
  workflow_id: string;
  schema: string;
}

export interface ValidateTreeError {
  node_error: { node_id: string; node_name: string } | null;
  path_error: unknown | null;
  message: string;
  type: number;
}

export interface ValidateTreeItem {
  workflow_id: string;
  name: string;
  errors: ValidateTreeError[];
}

export interface ValidateTreeData {
  // data 是数组，每个元素是 ValidateTreeItem
}
```

**方法签名**：
```typescript
async validateTree(workflowId: string, schemaJson: string): Promise<ValidateTreeItem[]>
```

**实现逻辑**：
- 调用 `this.request<ValidateTreeItem[]>("validate_tree", { workflow_id, schema })`（urlPrefix 默认）
- 返回 `data` 数组
- 校验失败时**不抛异常**，而是返回错误列表（让调用方决定怎么处理）

### 2. 修复 `queryExecute()` → 改为 `getProcess()`

**接口**：`GET /api/workflow_api/get_process`

**注意是 GET 请求，不是 POST！** 当前 `request()` 方法只支持 POST，需要加一个 `method` 参数支持 GET。

**修改 `request()` 方法**：加可选参数 `method: "POST" | "GET"`，默认 `"POST"`。GET 请求时：
- 不传 body
- 参数拼接在 URL 查询字符串上（`?key1=value1&key2=value2`）
- 保留其他 header

**接口参数**（GET 查询参数）：
```
workflow_id, space_id, execute_id, need_async=true
```

**响应**（关键字段，其他字段可忽略）：
```json
{
  "code": 0,
  "msg": "",
  "data": {
    "workFlowId": "string",
    "executeId": "string",
    "executeStatus": 2,  // 2=已完成
    "nodeResults": [
      {
        "nodeId": "100001",
        "NodeType": "Start",  // 注意是大写
        "NodeName": "开始",
        "nodeStatus": 3,  // 3=成功
        "errorInfo": "",
        "input": "{\"key\":\"value\"}",
        "output": "{\"key\":\"value\"}",
        "nodeExeCost": "0.001s",
        "tokenAndCost": { "inputTokens": "...", "outputTokens": "...", "totalTokens": "..." },
        "raw_output": "...",
        "errorLevel": "",
        "extra": "{}"
      }
    ],
    "rate": "1.00",
    "exeHistoryStatus": 2,
    "workflowExeCost": "15.324s",
    "reason": "",
    "logID": "..."
  }
}
```

**`executeStatus` 含义**（推测）：
- 0 = 排队中
- 1 = 运行中
- 2 = 已完成
- 3 = 失败

**`nodeStatus` 含义**（推测）：
- 0 = 等待中
- 1 = 运行中
- 2 = 跳过
- 3 = 成功
- 4 = 失败

**方法签名**：
```typescript
async getProcess(workflowId: string, executeId: string): Promise<{
  workFlowId: string;
  executeId: string;
  executeStatus: number;
  nodeResults: Array<{
    nodeId: string;
    NodeType: string;
    NodeName: string;
    nodeStatus: number;
    errorInfo: string;
    input: string;
    output: string;
    nodeExeCost: string;
    tokenAndCost: Record<string, string>;
    raw_output: string;
    errorLevel: string;
    extra: string;
  }>;
  exeHistoryStatus: number;
  workflowExeCost: string;
  reason: string;
}>
```

**注意**：`get_process` 和 `test_run` 都需要 `workflow_id` 参数。`test_run` 返回 `execute_id`，`get_process` 用 `workflow_id + execute_id` 查询。

### 3. 删除旧的 `queryExecute` 和 `ExecuteDetailData` 类型

删除 `types.ts` 中的：
- `ExecuteDetailRequest` 接口
- `ExecuteDetailData` 接口
- `ExecuteDetailData` 的 JSDoc 注释

删除 `coze.client.ts` 中的：
- `queryExecute()` 方法（整个方法）
- 相关的 `normalizeExecuteResult()` 方法
- 相关的 `findOutput()` 方法
- 注释中"候选接口路径"的说明

### 4. 修复 `save_to_coze` 工具 — 加入 validate_tree 校验

在 `save_to_coze` 工具的 `saveToCozeTool` 函数中，在 `convertToPlatformSchema` 之后、`createWorkflow` 之前，加入：

```typescript
// 1. 本地校验（已有）
// 2. 平台兼容性校验（已有）
// 3. 新增：平台 validate_tree 校验
const schemaJson = convertToPlatformSchema(workflow);
const validationErrors = await cozeClient.validateTree(
  cozeWorkflow.meta.name,  // 注意：这里需要 workflow_id，但还没创建。先传空字符串，让 validate_tree 返回格式错误？或者先在本地创建？
  schemaJson
);
```

**⚠️ 注意**：`validate_tree` 需要 `workflow_id`，但此时工作流还没创建。有两种方案：

**方案 A（推荐）**：先 `createWorkflow` 获取 `workflowId`，然后 `validateTree`，如果校验失败则返回错误并删除刚创建的工作流（目前没有 delete 接口，就返回错误让 LLM 修）。

**方案 B**：先 `validateTree` 用空 `workflow_id=""` 测试是否可行（实测确认）。

先按方案 A 实现：`createWorkflow` → `validateTree` → 有错误返回错误（不继续 save）→ 无错误才 `saveWorkflow`。

### 5. 修复 `batch_validate` 工具 — 改用 `getProcess`

将 `batchValidateTool` 中的轮询逻辑从 `queryExecute` 改为 `getProcess`：

```typescript
// 原来的：
const result = await cozeClient.queryExecute(executeId);
if (result.status === "success" || result.status === "fail") { ... }

// 改为：
const result = await cozeClient.getProcess(workflowId, executeId);
if (result.executeStatus === 2) {  // 已完成
  // 从 end 节点的 output 提取结果
  const endNode = result.nodeResults.find(n => n.NodeType === "End");
  const actual = endNode ? extractOutputString(endNode.output) : "";
}
```

**注意**：`getProcess` 需要 `workflowId`，而 `batchValidateTool` 已经有 `workflowId` 参数了。

### 6. 修复条件分支的边生成

**问题**：`generator.ts` 的 `buildWorkflow()` 方法中，条件节点有 N 个分支，但只创建了 1 条边（依赖树生成的边）。导致 N-1 个端口未连接。

**修复**：在 `fillConditionTargets` 函数之后，添加逻辑：

```typescript
// 为条件节点创建 N 条边，每条边对应一个分支
for (const node of cozeNodes) {
  if (node.type !== "condition") continue;
  const branches = (node as any).branches ?? [];
  const existingEdges = edges.filter(e => e.sourceNodeId === node.id);
  
  // 如果已有边数 < 分支数，补充缺失的边
  for (let i = existingEdges.length; i < branches.length; i++) {
    edges.push({
      id: generateId(),
      sourceNodeId: node.id,
      targetNodeId: branches[i].targetNodeId ?? "900001",
      sourcePort: determinePortName(i, branches.length),  // "true" / "false" / "true_1" / "true_2"
    });
  }
}
```

**端口命名规则**（根据 validate_tree 报错推测）：
```typescript
function determinePortName(index: number, total: number): string {
  if (total === 2) {
    return index === 0 ? "true" : "false";
  }
  // 3 分支：true, true_1, false
  // 4 分支：true, true_1, true_2, false
  if (index === 0) return "true";
  if (index === total - 1) return "false";
  return `true_${index}`;
}
```

**注意**：需要给 `CozeEdge` 类型加上 `sourcePort` 字段（`packages/workflow-schema/src/types/index.ts` 中）。

### 7. 修复 `CozeEdge` 类型定义

`packages/workflow-schema/src/types/index.ts` 中，`CozeEdge` 类型需要加上 `sourcePort` 字段：

```typescript
export interface CozeEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourcePort?: string;  // 新增：条件分支端口名（如 "true" / "false" / "true_1"）
}
```

## 验证

1. `pnpm typecheck` 全绿
2. `pnpm build` 全绿
3. 检查 `coze.client.ts` 中是否已删除 `queryExecute`、`normalizeExecuteResult`、`findOutput` 方法
4. 检查 `types.ts` 中是否已删除 `ExecuteDetailRequest` 和 `ExecuteDetailData`
5. 模拟一个多分支条件节点，验证 convertToPlatformSchema 后会生成 N 条边且每条边带 sourcePortID

### 8. 新增 `deleteWorkflow()` 方法（CozeClient + save.tool.ts 清理空壳）

**接口**：`POST /api/workflow_api/delete`

**请求体**：
```json
{
  "workflow_id": "string",
  "space_id": "string",
  "action": 1
}
```

**类型定义**（`types.ts` 中新增）：
```typescript
export interface DeleteWorkflowRequest {
  workflow_id: string;
  space_id: string;
  action: number;  // 1=删除
}
```

**方法签名**（`coze.client.ts` 中新增）：
```typescript
async deleteWorkflow(workflowId: string): Promise<void> {
  await this.request("delete", {
    workflow_id: workflowId,
    space_id: this.spaceId,
    action: 1,
  });
}
```

**在 `save.tool.ts` 中的应用**：
当 `validateTree` 校验失败时，删除刚创建的空壳工作流，再返回错误信息：

```typescript
// validate_tree 失败 → 删除空壳工作流 → 返回错误
const validationErrors = await cozeClient.validateTree(workflowId, schemaJson);
const errorMessages = validationErrors.flatMap((item) =>
  item.errors.map((e) => e.message),
);
if (errorMessages.length > 0) {
  // 删除空壳工作流，避免平台上残留垃圾
  try {
    await cozeClient.deleteWorkflow(workflowId);
  } catch {
    // 删除失败不影响主流程，继续返回错误信息
  }
  return `保存失败: 平台 validate_tree 校验未通过，已删除空壳工作流。请修复后重新 save_to_coze:\n` +
    errorMessages.map((m) => "- " + m).join("\n");
}
```

## 红线

- 不改 LLM planner 和 prompt
- 不改前端代码
- 不改其他工具的 schema 和逻辑
- 不改 schema-converter 的主逻辑