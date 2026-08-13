# Qoder 任务：CozeClient 日志增强——打印完整入参/出参

> 项目：`/Users/huzhiwu/workspace/ai-tools-demo/src/agent-coze-workflow`
> 技术栈：NestJS 11 + pnpm workspace
> **需求：调试工作流创建时，能直观看到"调用了什么接口、传入了什么参数、返回了什么参数"。当前日志：入参是 debug 级别（默认 info 看不到）且只截断 200 字符，出参完全没打印。**

---

## 一、当前日志现状（apps/api/src/coze/coze.client.ts 的 request()）

```
请求前：debug 级别  [CozeAPI] -> path body=<summarize 摘要，截断 200 字符>
成功：  info 级别   [CozeAPI] <- path code=0 xxxms（无返回参数）
失败：  warn 级别   [CozeAPI] !! path code=xxx msg=xxx
```

**问题：**
1. 入参是 `debug` 级别 → 默认 `LOG_LEVEL=info` 时看不到
2. `summarize()` 截断 200 字符 → 工作流 schema 大，看不到完整参数
3. 出参（返回数据）完全没打印

---

## 二、改法（apps/api/src/coze/coze.client.ts）

### 1. 入参日志：改 info 级别 + 完整打印

```ts
// 请求前：info 级别，打印完整 body（JSON 字符串，不截断或截断到 2000 字符）
this.logger.log(`[CozeAPI] -> ${path} body=${JSON.stringify(body)}`);
```

> 说明：body 里没有敏感字段（session_key 在 header 里，不在 body），可以完整打印。若担心 schema 太大刷屏，截断到 2000 字符即可（但 create 接口的 body 很小，必须完整）。

### 2. 出参日志：成功时打印返回数据

```ts
if (json.code !== 0) {
  // 失败：warn，code+msg（已有）
  this.logger.warn(
    `[CozeAPI] !! ${path} code=${json.code} msg=${json.msg} ${Date.now() - start}ms`,
  );
  throw new Error(`CozeError[${json.code}]: ${json.msg}`);
}

// 成功：info，打印返回数据（data 字段，完整 JSON）
this.logger.log(
  `[CozeAPI] <- ${path} code=${json.code} ${Date.now() - start}ms data=${JSON.stringify(json.data ?? {})}`,
);
```

> 返回数据可能很大（如 canvas 的 schema_json），可以只打印 `data` 的摘要：`JSON.stringify(json.data)` 截断 2000 字符，或打印 `Object.keys(json.data)`。**create 接口的返回（workflow_id）很小，必须完整打印。**

### 3. summarize() 保留但不再用于入参

- `summarize()` 方法保留（其他场景可能用），但 request() 的入参日志不再用它
- 或修改 summarize 截断长度 200 → 2000

### 4. 日志格式统一（方便 grep）

```
入参：[CozeAPI] -> {path} body={json}
出参：[CozeAPI] <- {path} code={code} {ms}ms data={json}
失败：[CozeAPI] !! {path} code={code} msg={msg} {ms}ms
```

---

## 三、验收标准

1. `pnpm --filter @coze-workflow/api typecheck` 全绿；`pnpm build` 全绿
2. **默认 LOG_LEVEL（info）下就能看到**：
   - 调一次创建流程（curl 或 Agent 触发），日志里出现：
     - `[CozeAPI] -> create body={"name":"...","desc":"...","icon_uri":"default_icon/default_workflow_icon.png","space_id":"...","flow_mode":0}`
     - `[CozeAPI] <- create code=0 xxxms data={"workflow_id":"7673..."}`
   - 完整看到入参（含 icon_uri、flow_mode）和出参（含 workflow_id）
3. edit_lock / canvas / save 接口同样能看到完整入参出参
4. 无敏感信息泄露（body 无 session_key，若有打印前先确认）

---

## 四、红线

- ❌ 不打印 session_key / 任何凭证
- ❌ 不加新依赖
- ✅ 只改 coze.client.ts 的 request() 方法（日志部分）
- ✅ 日志级别：入参/出参用 info（默认可见），失败用 warn，保持现有风格
