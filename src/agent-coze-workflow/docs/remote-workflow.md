# 远程协作手册（公司电脑 ↔ 家里 AI）

> 场景：志武明天在公司电脑开发（没有 OpenClaw），家里的 MacBook 上有来财（OpenClaw agent）。
> 中转站：GitHub 私有仓库 `huzhiwu1/ai-tools-demo`。

## 一、协作模式（模式 1：双向 push）

```
公司电脑（Qoder 干活）  ──push──→  GitHub 私有仓库  ←──pull──  家里（来财 review/提交）
        ↑                                                          │
        └────────────────── pull ←────────────────────────────────┘
```

- **志武在公司**：Qoder 写代码 → commit → push
- **来财在家里**：pull → typecheck/build 验证 → 审查 → 提交建议/修复 → push
- **沟通**：飞书聊天（志武发需求/进度，来财产 prompt/审查结论/讲解）

## 二、公司电脑首次配置（5 分钟）

```bash
# 1. 克隆
git clone https://github.com/huzhiwu1/ai-tools-demo.git
cd ai-tools-demo/src/agent-coze-workflow

# 2. git 身份（用一次即可，仓库已配置可跳过）
git config user.name "huzhiwu"
git config user.email "15360829514@163.com"

# 3. 认证（二选一）
#    方式 A：gh 登录
gh auth login   # GitHub.com → HTTPS → 浏览器登录
#    方式 B：git 凭据
#    在 GitHub Settings → Developer settings → Personal access tokens 生成 PAT（repo 权限）
git config --global credential.helper osxkeychain

# 4. 环境变量（必须！从家里 .env 拷贝，或重新抓取）
#    DEEPSEEK_API_KEY（LLM 规划用）
#    COZE_SESSION_KEY（Coze 平台 cookie，注意每天过期要重新抓）
#    COZE_SPACE_ID=7560621359533916160
#    COZE_API_BASE_URL=https://coze.dev1.dachensky.com
cp .env.example .env  # 然后编辑填入真实值

# 5. 安装依赖并启动
pnpm install
pnpm dev
```

## 三、每天的工作流

### 志武在公司
1. `git pull`（拿到来财昨晚的提交）
2. 让 Qoder 干活（任务 prompt 由来财通过飞书提供）
3. 验证 → `git add -A && git commit -m "..." && git push`
4. 飞书告诉来财：推完了

### 来财在家里
1. `git pull` 拉取新代码
2. `pnpm typecheck && pnpm build` 验证
3. 审查 diff → 发现问题直接修复提交（`git push`）
4. 飞书输出：审查结论 + 面试考点 + 下一步任务 prompt

## 四、注意事项

- **COZE_SESSION_KEY 每天过期**（22:33 左右）：家里和公司都要更新。过期后 CozeClient 自动降级 mock，不影响本地链路
- **.env 绝不提交**（已 gitignore，含 DEEPSEEK/COZE key）
- **冲突处理**：如果 push 被拒（远程有更新），先 `git pull --rebase` 再 push
- **大文件**：node_modules/dist 不提交（gitignore 已配）
- **飞书消息格式**：纯文字 + bullet，不用表格

## 五、紧急情况

- 家里 MacBook 关机/断网 → 志武可以独立干活（Qoder + 仓库），来财回来再同步
- 公司 push 冲突 → 保留自己的改动，pull --rebase 解决，必要时重建分支
