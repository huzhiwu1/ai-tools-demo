# Docker 小白渐进式任务教程

> 规则：每次只给出一个任务，完成后提交验收，审批通过后再进入下一任务。

---

## 【任务1】认识 Docker + 安装验证

**预计时间**：15~30 分钟

**学习目标**：

1. 理解 Docker 解决了什么问题
2. 掌握 4 个核心概念（镜像、容器、仓库、Docker Engine）
3. 在自己的电脑上成功安装 Docker 并运行验证

---

### 一、前置阅读（5分钟）

先理解下面这个场景：

> 你开发了一个 Node.js 后端项目，在自己的电脑上跑得好好的。发给同事后，同事却说跑不起来：
>
> - "我这边 Node 版本是 16，你那边是 18，不兼容"
> - "我缺少 Python 依赖，安装报错了"
> - "Windows 上能跑，Linux 服务器上跑不了"
>
> **Docker 就是来解决这个问题的** —— 它把你的代码 + 运行环境 + 系统依赖，打包成一个「集装箱」（镜像）。无论搬到哪台机器上，里面东西一模一样，开箱即用。

**核心比喻**：

| 现实概念         | Docker 概念      | 一句话解释                         |
| ---------------- | ---------------- | ---------------------------------- |
| 集装箱模板       | 镜像 (Image)     | 只读的模板，包含运行应用所需的一切 |
| 正在运行的集装箱 | 容器 (Container) | 镜像的实例，真正在跑的进程         |
| 集装箱仓库       | 仓库 (Registry)  | 存放镜像的地方，如 Docker Hub      |
| 码头工人         | Docker Engine    | 管理镜像和容器的后台服务           |

**容器的关键特性**：

- 相互隔离：每个容器有自己的文件系统、网络、端口
- 轻量级：比虚拟机快得多，秒级启动
- 可移植：一次构建，到处运行

---

### 二、安装 Docker（Windows）

#### 步骤1：下载安装

1. 访问 https://www.docker.com/products/docker-desktop
2. 下载 **Docker Desktop for Windows**
3. 双击安装，按提示完成（可能需要开启 WSL2，按向导操作即可）
4. 安装完成后**重启电脑**
5. 打开 Docker Desktop，左下角显示 **"Docker Engine running"** 即为成功

> 如果安装过程中提示开启 WSL2 或 Hyper-V，点击「确定」让安装程序自动配置即可。

#### 步骤2：验证安装

打开 **Git Bash**（或 PowerShell），依次执行以下命令：

```bash
# 查看 Docker 版本
docker --version
```

**预期输出**：

```
Docker version 26.0.0, build 2ae903e
```

```bash
# 运行官方测试镜像
docker run hello-world
```

**预期输出**（看到这段说明成功）：

```
Hello from Docker!
This message shows that your installation appears to be working correctly.
```

---

### 三、动手实验：运行你的第一个容器

执行下面的命令，拉取并运行一个 Nginx 容器（一个 Web 服务器）：

```bash
# 运行 Nginx 容器
# -d: 后台运行
# -p 8080:80: 把宿主机的 8080 端口映射到容器的 80 端口
# --name: 给容器起名字
docker run -d -p 8080:80 --name my-nginx nginx:latest
```

然后验证：

```bash
# 查看运行中的容器
docker ps
```

**预期输出**：能看到 `my-nginx` 这个容器在运行。

打开浏览器访问 http://localhost:8080 ，你应该能看到 **"Welcome to nginx!"** 页面。

实验完成后，清理容器：

```bash
# 停止容器
docker stop my-nginx

# 删除容器
docker rm my-nginx

# 查看是否还有运行中的容器（应该为空）
docker ps
```

---

### 四、理解刚才发生了什么

```
你执行了 docker run nginx:latest
                │           │
                │           └── 镜像名称和标签
                └── 命令：运行一个容器

Docker 引擎做了这些事：
1. 检查本地有没有 nginx:latest 镜像 → 没有
2. 从 Docker Hub 拉取镜像 → 下载到本地
3. 基于镜像创建一个容器 → 分配资源、启动进程
4. 把容器的 80 端口映射到宿主机的 8080 端口
5. 容器开始运行，你在浏览器看到了 Nginx 欢迎页
```

---

### 五、本任务验收清单

完成后，请把以下内容发给我进行审批：

1. `docker --version` 的输出截图/复制文本
2. `docker run hello-world` 的输出（最后几行即可）
3. `docker ps` 运行 Nginx 后的输出（显示 my-nginx 容器）
4. 回答这个问题：**镜像和容器的区别是什么？用你自己的话描述**

---

### 六、审批标准

| 检查项      | 标准                             |
| ----------- | -------------------------------- |
| Docker 安装 | `docker --version` 有版本号输出  |
| hello-world | 看到 "Hello from Docker!"        |
| Nginx 容器  | `docker ps` 显示 my-nginx 在运行 |
| 概念理解    | 能用自己的话区分镜像和容器       |

**全部通过 → 进入【任务2】**

---

（以下任务将在你完成当前任务后依次解锁）

---

## 【任务2】运行现成容器（hello-world + MySQL）

**预计时间**：20~30 分钟

**学习目标**：

1. 掌握 `docker run` 的核心参数（-d, -p, -e, -v, --name）
2. 成功用 Docker 启动一个 MySQL 数据库
3. 理解端口映射和环境变量的作用
4. 理解数据持久化（Volume）的必要性

---

### 一、核心参数学习

运行容器时最常用的 5 个参数：

| 参数     | 全称     | 作用                    | 示例                            |
| -------- | -------- | ----------------------- | ------------------------------- |
| `-d`     | detached | 后台运行                | `docker run -d nginx`           |
| `-p`     | publish  | 端口映射（宿主机:容器） | `-p 3306:3306`                  |
| `-e`     | env      | 设置环境变量            | `-e MYSQL_ROOT_PASSWORD=admin`  |
| `-v`     | volume   | 数据卷映射（持久化）    | `-v /host/data:/container/data` |
| `--name` | name     | 给容器命名              | `--name mysql-dev`              |

---

### 二、实验1：用 Docker 启动 MySQL

#### 步骤1：启动 MySQL 容器

```bash
docker run -d \
  --name mysql-dev \
  -p 3306:3306 \
  -e MYSQL_ROOT_PASSWORD=admin \
  -e MYSQL_DATABASE=book \
  mysql:latest
```

参数解析：

- `-d`：后台运行，不占用当前终端
- `--name mysql-dev`：容器名叫 mysql-dev
- `-p 3306:3306`：把容器里的 3306 端口映射到宿主机的 3306
- `-e MYSQL_ROOT_PASSWORD=admin`：设置 root 密码为 admin
- `-e MYSQL_DATABASE=book`：启动时自动创建 book 数据库

#### 步骤2：检查 MySQL 是否启动成功

```bash
# 查看容器状态
docker ps

# 查看 MySQL 容器日志（看有没有报错）
docker logs mysql-dev
```

等日志里出现 `ready for connections` 说明启动成功了。

#### 步骤3：进入 MySQL 容器内部

```bash
# 进入容器内部的 bash
docker exec -it mysql-dev bash

# 在容器内部登录 MySQL
mysql -uroot -padmin

# 查看有哪些数据库
SHOW DATABASES;

# 应该能看到 book 数据库
# 退出 MySQL
EXIT;

# 退出容器
exit
```

#### 步骤4：清理

```bash
# 停止并删除容器
docker stop mysql-dev
docker rm mysql-dev
```

---

### 三、实验2：理解数据持久化的重要性

上面的实验有一个**大问题**：删除容器后，数据也没了。

#### 步骤1：启动不带 Volume 的 MySQL，插入数据

```bash
# 启动容器
docker run -d \
  --name mysql-test \
  -p 3306:3306 \
  -e MYSQL_ROOT_PASSWORD=admin \
  -e MYSQL_DATABASE=book \
  mysql:latest

# 等待几秒让 MySQL 启动
sleep 10

# 进入容器创建表
docker exec -it mysql-test mysql -uroot -padmin -e "
USE book;
CREATE TABLE test_table (id INT, name VARCHAR(50));
INSERT INTO test_table VALUES (1, 'Hello Docker');
SELECT * FROM test_table;
"
```

#### 步骤2：删除容器再重建

```bash
# 删除容器
docker stop mysql-test
docker rm mysql-test

# 重新启动一个同名的新容器
docker run -d \
  --name mysql-test \
  -p 3306:3306 \
  -e MYSQL_ROOT_PASSWORD=admin \
  -e MYSQL_DATABASE=book \
  mysql:latest

sleep 10

# 尝试查询刚才的数据
docker exec -it mysql-test mysql -uroot -padmin -e "
USE book;
SHOW TABLES;
"
```

**你会发现**：`test_table` 不见了！因为容器删除时，里面的数据也跟着没了。

#### 步骤3：用 Volume 实现数据持久化

```bash
# 先删除旧容器
docker stop mysql-test
docker rm mysql-test

# 启动时加上 -v 参数，把容器内的数据目录映射到宿主机
docker run -d \
  --name mysql-persist \
  -p 3306:3306 \
  -e MYSQL_ROOT_PASSWORD=admin \
  -e MYSQL_DATABASE=book \
  -v ~/docker-data/mysql:/var/lib/mysql \
  mysql:latest

sleep 10

# 插入数据
docker exec -it mysql-persist mysql -uroot -padmin -e "
USE book;
CREATE TABLE persistent_table (id INT, name VARCHAR(50));
INSERT INTO persistent_table VALUES (1, 'I will survive');
SELECT * FROM persistent_table;
"
```

#### 步骤4：验证持久化

```bash
# 删除容器
docker stop mysql-persist
docker rm mysql-persist

# 重新启动，继续使用同一个 Volume
docker run -d \
  --name mysql-persist2 \
  -p 3306:3306 \
  -e MYSQL_ROOT_PASSWORD=admin \
  -v ~/docker-data/mysql:/var/lib/mysql \
  mysql:latest

sleep 10

# 查询数据还在不在
docker exec -it mysql-persist2 mysql -uroot -padmin -e "
USE book;
SELECT * FROM persistent_table;
"
```

**你会发现**：数据还在！因为数据实际存储在宿主机的 `~/docker-data/mysql` 目录里，容器只是「借用」这个目录。

#### 步骤5：清理

```bash
docker stop mysql-persist2
docker rm mysql-persist2
```

---

### 四、本任务验收清单

完成后，请把以下内容发给我：

1. `docker ps` 显示 MySQL 容器在运行的截图
2. 进入 MySQL 后 `SHOW DATABASES;` 能看到 `book` 数据库的输出
3. 回答以下问题：
   - `-p 3306:3306` 是什么意思？
   - `-e MYSQL_ROOT_PASSWORD=admin` 是什么意思？
   - 为什么需要用 `-v` 做数据持久化？

---

### 五、审批标准

| 检查项     | 标准                                         |
| ---------- | -------------------------------------------- |
| MySQL 启动 | `docker ps` 显示 mysql-dev 在运行            |
| 数据库连接 | 能进入 MySQL 并执行命令                      |
| 持久化实验 | 理解删除容器数据会丢失，加 Volume 后数据保留 |
| 参数理解   | 能解释 -p、-e、-v 三个参数的含义             |

**全部通过 → 进入【任务3】**

---

## 【任务3】编写单阶段 Dockerfile 打包 NestJS

**预计时间**：30~40 分钟

**学习目标**：

1. 理解 Dockerfile 的语法和每条指令的作用
2. 能独立编写一个单阶段 Dockerfile
3. 成功将 NestJS 项目构建为 Docker 镜像并运行

---

### 一、前置准备

#### 步骤1：创建 NestJS 项目

```bash
# 如果你还没有 nestjs/cli
npm install -g @nestjs/cli

# 创建项目
nest new nest-docker-test

# 进入项目目录
cd nest-docker-test

# 生成一个资源模块（比如 book）
nest g res book --no-spec
```

#### 步骤2：创建 .dockerignore

在项目根目录创建 `.dockerignore` 文件：

```
node_modules/
.vscode/
.git/
```

> 作用：构建镜像时，忽略这些文件，避免把它们复制进镜像里（节省空间、加速构建）。

---

### 二、编写 Dockerfile

在项目根目录创建 `Dockerfile`（注意没有后缀）：

```dockerfile
# 指定基础镜像（必须第一行）
# node:24.15-alpine 表示 Node.js 24.15 版本 + Alpine Linux（超小系统）
FROM node:24.15-alpine

# 设置容器内的工作目录
WORKDIR /app

# 先复制 package.json 和 package-lock.json
# 为什么要先复制这两个？
# 因为 Docker 有缓存机制：如果这两个文件没变，npm install 就不会重新执行
COPY package*.json ./

# 设置国内镜像源（加速下载）
RUN npm config set registry https://registry.npmmirror.com/

# 安装项目依赖
RUN npm install

# 全局安装 NestJS CLI（用于编译）
RUN npm install -g @nestjs/cli

# 复制项目所有源代码到容器内
COPY . .

# 编译项目：TS -> JS
RUN npm run build

# 声明容器会监听 3000 端口（仅声明，实际映射靠 docker run -p）
EXPOSE 3000

# 容器启动时执行的命令
CMD ["node", "dist/main.js"]
```

---

### 三、指令逐行对照表

| 指令      | 作用                     | 是在构建时执行还是运行时执行？ |
| --------- | ------------------------ | ------------------------------ |
| `FROM`    | 指定基础镜像             | 构建时                         |
| `WORKDIR` | 设置容器内的工作目录     | 构建时                         |
| `COPY`    | 把宿主机文件复制到容器内 | 构建时                         |
| `RUN`     | 执行命令                 | **构建时**                     |
| `EXPOSE`  | 声明端口（文档作用）     | 构建时                         |
| `CMD`     | 容器启动时执行的默认命令 | **运行时**                     |

**关键区分**：

- `RUN`：构建镜像时执行（如 npm install、npm run build）
- `CMD`：容器启动时才执行（如 node dist/main.js）

---

### 四、构建并运行

#### 步骤1：构建镜像

```bash
# 在项目根目录执行
# -t: tag，给镜像起名字和版本
docker build -t nest-app:v1 .
```

构建过程你会看到 Docker 逐行执行 Dockerfile 里的指令。如果最后出现 `Successfully tagged nest-app:v1`，说明构建成功。

#### 步骤2：查看镜像

```bash
docker images
```

你应该能看到 `nest-app` 这个镜像。

#### 步骤3：运行容器

```bash
docker run -d \
  -p 3000:3000 \
  --name nest-container \
  nest-app:v1
```

#### 步骤4：验证

```bash
# 查看容器是否运行
docker ps

# 查看日志
docker logs nest-container

# 测试接口
curl http://localhost:3000
```

NestJS 默认返回 `{"statusCode":404,"message":"Cannot GET /","error":"Not Found"}`，这是正常的，说明服务跑起来了。

---

### 五、本任务验收清单

完成后，请把以下内容发给我：

1. 你的 Dockerfile 完整内容
2. `docker images` 显示 `nest-app:v1` 的输出
3. `docker ps` 显示 `nest-container` 在运行的输出
4. `curl http://localhost:3000` 的返回结果
5. 回答：为什么要把 `COPY package*.json` 放在 `COPY . .` 之前？

---

### 六、审批标准

| 检查项     | 标准                                       |
| ---------- | ------------------------------------------ |
| Dockerfile | 包含 FROM、WORKDIR、COPY、RUN、EXPOSE、CMD |
| 镜像构建   | `docker images` 能看到 nest-app:v1         |
| 容器运行   | `docker ps` 显示 nest-container 在运行     |
| 接口可达   | curl localhost:3000 有响应                 |
| 缓存理解   | 能解释 package\*.json 先复制的原因         |

**全部通过 → 进入【任务4】**

---

## 【任务4】多阶段构建优化镜像体积

**预计时间**：25~35 分钟

**学习目标**：

1. 理解单阶段构建的问题（镜像过大）
2. 掌握多阶段构建的原理和写法
3. 对比单阶段和多阶段的镜像体积差异

---

### 一、问题发现

在任务3中，你构建的镜像包含了：

- 源代码（src/）
- 开发依赖（typescript、@nestjs/cli）
- 编译后的代码（dist/）

但生产环境运行时，只需要 **编译后的代码 + 生产依赖**。多余的文件会：

1. 增加镜像体积（可能多出几百 MB）
2. 增加攻击面（多余工具 = 潜在安全隐患）

---

### 二、多阶段构建原理

把构建过程拆成多个阶段，**最终镜像只保留最后一个阶段的内容**。

```
┌─────────────────┐
│   builder 阶段   │  ← 包含完整的 devDependencies，用于编译
│  (编译后丢弃)    │
└────────┬────────┘
         │ COPY --from=builder /app/dist ./dist
         ▼
┌─────────────────┐
│ production 阶段 │  ← 只保留生产依赖 + dist 目录
│  (最终镜像)     │     镜像体积大幅减小
└─────────────────┘
```

---

### 三、编写多阶段 Dockerfile

把原来的 Dockerfile 改成多阶段：

```dockerfile
# ============================================
# 阶段一：builder（构建阶段）
# 需要完整的依赖（包括 devDependencies）才能编译
# ============================================
FROM node:24.15-alpine AS builder

WORKDIR /app

COPY package*.json ./

RUN npm config set registry https://registry.npmmirror.com/
RUN npm install

COPY . .

RUN npm run build

# ============================================
# 阶段二：production（运行阶段）
# 只保留生产依赖 + 编译产物
# ============================================
FROM node:24.15-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./

RUN npm config set registry https://registry.npmmirror.com/
# --production 只安装 dependencies，不装 devDependencies
RUN npm install --production

# 从 builder 阶段复制编译产物
COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/main.js"]
```

**关键语法**：

- `FROM ... AS builder`：给阶段命名
- `COPY --from=builder /app/dist ./dist`：从 builder 阶段复制文件到当前阶段

---

### 四、构建并对比

#### 步骤1：用多阶段构建

```bash
# 构建（会覆盖原来的 Dockerfile）
docker build -t nest-app:prod .
```

#### 步骤2：对比镜像大小

```bash
docker images | grep nest-app
```

**预期结果**：

- `nest-app:v1`（单阶段）：可能 500MB+
- `nest-app:prod`（多阶段）：可能 100~150MB

> 差距主要来自：去掉了 devDependencies（typescript、@nestjs/cli 等）

#### 步骤3：验证功能是否正常

```bash
# 停止旧容器
docker stop nest-container
docker rm nest-container

# 运行多阶段构建的镜像
docker run -d \
  -p 3000:3000 \
  --name nest-prod \
  nest-app:prod

# 测试
curl http://localhost:3000
```

---

### 五、对比总结

| 维度     | 单阶段 (v1)              | 多阶段 (prod)    |
| -------- | ------------------------ | ---------------- |
| 镜像大小 | 大（含 devDependencies） | 小（仅生产依赖） |
| 构建时间 | 较短                     | 稍长（两个阶段） |
| 安全性   | 低（多余工具暴露攻击面） | 高               |
| 适用场景 | 开发环境                 | 生产环境         |

---

### 六、本任务验收清单

完成后，请把以下内容发给我：

1. 你的多阶段 Dockerfile 完整内容
2. `docker images | grep nest-app` 的输出（显示 v1 和 prod 的体积对比）
3. `curl http://localhost:3000` 的返回结果（证明多阶段镜像能正常运行）
4. 回答：多阶段构建为什么能减小镜像体积？

---

### 七、审批标准

| 检查项     | 标准                                      |
| ---------- | ----------------------------------------- |
| Dockerfile | 正确使用 `AS builder` 和 `--from=builder` |
| 镜像体积   | prod 标签的镜像明显小于 v1                |
| 功能正常   | 多阶段构建的容器能响应请求                |
| 原理理解   | 能解释为什么多阶段构建更小                |

**全部通过 → 进入【任务5】**

---

## 【任务5】.dockerignore + 常用命令实操

**预计时间**：20~30 分钟

**学习目标**：

1. 掌握 .dockerignore 的作用和写法
2. 熟练运用日常 Docker 命令（ps、logs、exec、stop、rm 等）
3. 学会清理不用的镜像和容器

---

### 一、.dockerignore 深度实践

#### 问题

`COPY . .` 会把当前目录**所有文件**复制进镜像。有些东西不需要：

- `node_modules/`：容器内会重新 npm install
- `.git/`：版本控制文件
- `dist/`：旧编译产物
- `.env`：可能包含敏感信息

#### 完善 .dockerignore

把你项目里的 `.dockerignore` 改成：

```
# 依赖目录
node_modules/
npm-debug.log
yarn-error.log

# 版本控制
.git/
.gitignore

# 编辑器配置
.vscode/
.idea/

# 测试文件
test/
coverage/
*.spec.ts
*.test.ts

# 本地环境文件（可能含密码！）
.env
.env.local

# 旧编译产物（会在容器内重新生成）
dist/

# Docker 自身文件
.dockerignore
Dockerfile*
docker-compose*.yml

# 文档
README.md
*.md
```

#### 验证 .dockerignore 生效

```bash
# 构建时加上 --progress=plain，观察 COPY . . 时复制了哪些文件
docker build --progress=plain -t nest-app:ignore-test .
```

如果配置正确，你不会看到 `node_modules/` 被复制进容器。

---

### 二、常用命令实操练习

按顺序执行以下命令，理解每个命令的作用：

```bash
# 1. 查看所有镜像
docker images

# 2. 查看运行中的容器
docker ps

# 3. 查看所有容器（包括已停止的）
docker ps -a

# 4. 查看容器日志（最近 50 行）
docker logs --tail 50 nest-prod

# 5. 持续跟踪日志（按 Ctrl+C 退出）
docker logs -f nest-prod

# 6. 进入容器内部的 shell
docker exec -it nest-prod sh

# 在容器内部，你可以查看文件系统：
# ls -la
# cat package.json
# exit  （退出容器）

# 7. 停止容器
docker stop nest-prod

# 8. 启动已停止的容器
docker start nest-prod

# 9. 重启容器
docker restart nest-prod

# 10. 删除已停止的容器
docker stop nest-prod
docker rm nest-prod

# 11. 强制删除运行中的容器
docker rm -f nest-prod
```

---

### 三、清理命令

```bash
# 删除所有已停止的容器
docker container prune

# 删除所有未使用的镜像
docker image prune

# 删除所有未使用的卷
docker volume prune

# 一键清理所有未使用的东西（容器、镜像、卷、网络）
# ⚠️ 慎用！确保你不需要这些资源了
docker system prune -a
```

---

### 四、本任务验收清单

完成后，请把以下内容发给我：

1. 你的 `.dockerignore` 完整内容
2. 执行以下命令的输出：
   ```bash
   docker images
   docker ps -a
   ```
3. 执行 `docker exec -it <你的容器名> sh` 后，在容器内执行 `ls -la` 的输出
4. 回答：`.dockerignore` 和 `.gitignore` 有什么相似之处？

---

### 五、审批标准

| 检查项        | 标准                                         |
| ------------- | -------------------------------------------- |
| .dockerignore | 包含 node_modules、.git、.env、dist 等关键项 |
| 命令掌握      | 能熟练使用 ps、logs、exec、stop、rm          |
| 容器操作      | 能进入容器内部查看文件系统                   |
| 概念理解      | 能类比 .gitignore 解释 .dockerignore         |

**全部通过 → 进入【任务6】**

---

## 【任务6】Docker Compose 一键启动 MySQL

**预计时间**：25~35 分钟

**学习目标**：

1. 理解 Docker Compose 的作用
2. 编写第一个 docker-compose.yml
3. 用一条命令启动/停止多个容器
4. 理解容器间如何通过服务名通信

---

### 一、为什么要用 Docker Compose

前面的任务中，你手动执行了很长的 `docker run` 命令：

```bash
docker run -d \
  --name mysql-dev \
  -p 3306:3306 \
  -e MYSQL_ROOT_PASSWORD=admin \
  -e MYSQL_DATABASE=book \
  -v ~/docker-data/mysql:/var/lib/mysql \
  mysql:latest
```

如果后端需要 MySQL + Redis + Milvus，你就要执行 3 条这样的命令，还要记住每个的参数。**Docker Compose 把这一切写在配置文件里，一条命令搞定。**

---

### 二、编写 docker-compose.yml

在项目根目录创建 `docker-compose.yml`：

```yaml
version: "3.8"

services:
  # MySQL 服务
  mysql:
    image: mysql:latest
    container_name: mysql-dev
    ports:
      - "3306:3306"
    environment:
      MYSQL_ROOT_PASSWORD: admin
      MYSQL_DATABASE: book
    command: mysqld --character-set-server=utf8mb4 --collation-server=utf8mb4_general_ci
    volumes:
      - ./volumes/mysql:/var/lib/mysql
    restart: always
```

---

### 三、启动和管理

```bash
# 启动服务（-d 后台运行）
docker-compose up -d

# 查看状态
docker-compose ps

# 查看日志
docker-compose logs -f mysql

# 停止服务（保留容器，下次 up 直接启动）
docker-compose stop

# 停止并删除容器、网络
docker-compose down

# 停止并删除容器 + 数据卷（会清空数据！慎用）
docker-compose down -v
```

---

### 四、在 package.json 里封装命令

编辑 `package.json` 的 scripts 部分：

```json
{
  "scripts": {
    "docker:up": "docker-compose up -d",
    "docker:down": "docker-compose down",
    "docker:logs": "docker-compose logs -f",
    "build": "nest build",
    "start:dev": "nest start --watch"
  }
}
```

然后可以用 npm 命令操作：

```bash
npm run docker:up
npm run docker:down
npm run docker:logs
```

---

### 五、本任务验收清单

完成后，请把以下内容发给我：

1. 你的 `docker-compose.yml` 完整内容
2. `docker-compose ps` 的输出（显示 mysql-dev 在运行）
3. `docker-compose logs --tail 20 mysql` 的输出（能看到 ready for connections）
4. 执行以下命令的输出：
   ```bash
   docker exec -it mysql-dev mysql -uroot -padmin -e "SHOW DATABASES;"
   ```

---

### 六、审批标准

| 检查项     | 标准                                         |
| ---------- | -------------------------------------------- |
| 配置文件   | docker-compose.yml 语法正确，包含 mysql 服务 |
| 启动成功   | docker-compose ps 显示 mysql 在运行          |
| 日志正常   | 能看到 ready for connections                 |
| 数据库连接 | 能查询到 book 数据库                         |

**全部通过 → 进入【任务7】**

---

## 【任务7】Docker Compose 启动 Milvus 全家桶

**预计时间**：30~40 分钟

**学习目标**：

1. 理解 Milvus 向量数据库的架构依赖（etcd + MinIO + Milvus）
2. 编写包含多个服务的 docker-compose.yml
3. 理解 depends_on 和 healthcheck 的作用
4. 理解容器间网络通信（通过服务名访问）

---

### 一、Milvus 架构简介

Milvus 是一个向量数据库，但它本身需要依赖其他服务：

| 组件   | 作用                       | 类比               |
| ------ | -------------------------- | ------------------ |
| etcd   | 存储元数据、服务发现       | 相当于「通讯录」   |
| MinIO  | 对象存储，存向量数据和日志 | 相当于「硬盘」     |
| Milvus | 向量搜索引擎               | 相当于「查询引擎」 |

---

### 二、编写 docker-compose.dev.yml

在项目根目录创建 `docker-compose.dev.yml`：

```yaml
version: "3.8"

services:
  # MySQL（之前任务6的内容）
  mysql:
    image: mysql:latest
    container_name: mysql-dev
    ports:
      - "3306:3306"
    environment:
      MYSQL_ROOT_PASSWORD: admin
      MYSQL_DATABASE: book
    command: mysqld --character-set-server=utf8mb4 --collation-server=utf8mb4_general_ci
    volumes:
      - ${DOCKER_VOLUME_DIRECTORY:-.}/volumes/mysql:/var/lib/mysql
    restart: always

  # etcd：Milvus 的元数据存储
  etcd:
    container_name: milvus-etcd
    image: quay.io/coreos/etcd:v3.5.18
    environment:
      - ETCD_AUTO_COMPACTION_MODE=revision
      - ETCD_AUTO_COMPACTION_RETENTION=1000
      - ETCD_QUOTA_BACKEND_BYTES=4294967296
    volumes:
      - ${DOCKER_VOLUME_DIRECTORY:-.}/volumes/etcd:/etcd
    command: etcd -advertise-client-urls=http://etcd:2379 -listen-client-urls=http://0.0.0.0:2379
    healthcheck:
      test: ["CMD", "etcdctl", "endpoint", "health"]
      interval: 30s
      timeout: 20s
      retries: 3

  # MinIO：对象存储
  minio:
    container_name: milvus-minio
    image: minio/minio:RELEASE.2024-05-28T17-19-04Z
    environment:
      MINIO_ACCESS_KEY: minioadmin
      MINIO_SECRET_KEY: minioadmin
    ports:
      - "9001:9001"
      - "9000:9000"
    volumes:
      - ${DOCKER_VOLUME_DIRECTORY:-.}/volumes/minio:/minio_data
    command: minio server /minio_data --console-address ":9001"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 30s
      timeout: 20s
      retries: 3

  # Milvus：向量数据库主服务
  standalone:
    container_name: milvus-standalone
    image: milvusdb/milvus:v2.5.25
    command: ["milvus", "run", "standalone"]
    environment:
      ETCD_ENDPOINTS: etcd:2379
      MINIO_ADDRESS: minio:9000
    volumes:
      - ${DOCKER_VOLUME_DIRECTORY:-.}/volumes/milvus:/var/lib/milvus
    ports:
      - "19530:19530"
      - "9091:9091"
    depends_on:
      - etcd
      - minio

networks:
  default:
    name: common-network
```

---

### 三、关键知识点

#### 1. depends_on

```yaml
depends_on:
  - etcd
  - minio
```

这确保 Milvus 启动前，etcd 和 minio **已经先启动**。但注意：`depends_on` 只保证启动顺序，不保证服务完全就绪。

#### 2. healthcheck

etcd 和 minio 配置了 `healthcheck`，Docker 会定期检查它们是否真的「健康」了。

#### 3. 容器间通信

在同一个 Docker Compose 网络中，容器可以通过**服务名**互相访问：

```yaml
environment:
  ETCD_ENDPOINTS: etcd:2379 # etcd 就是服务名！
  MINIO_ADDRESS: minio:9000 # minio 就是服务名！
```

Docker 会自动把服务名解析为对应的容器 IP。

#### 4. 环境变量 `${DOCKER_VOLUME_DIRECTORY:-.}`

- 如果有 `DOCKER_VOLUME_DIRECTORY` 环境变量，就用它的值
- 否则默认用当前目录 `.`

这让数据卷路径可以灵活配置。

---

### 四、启动并验证

```bash
# 启动所有服务（第一次启动会下载多个镜像，可能需要几分钟）
docker-compose -f docker-compose.dev.yml up -d

# 查看状态
docker-compose -f docker-compose.dev.yml ps

# 查看日志（Milvus 启动较慢，耐心等待）
docker-compose -f docker-compose.dev.yml logs -f standalone
```

---

### 五、本任务验收清单

完成后，请把以下内容发给我：

1. 你的 `docker-compose.dev.yml` 完整内容
2. `docker-compose -f docker-compose.dev.yml ps` 的输出（显示所有服务都在运行）
3. 回答以下问题：
   - Milvus 为什么需要 etcd 和 minio？
   - `depends_on` 的作用是什么？
   - Milvus 配置里写的是 `etcd:2379`，为什么不需要写 IP 地址？

---

### 六、审批标准

| 检查项   | 标准                                         |
| -------- | -------------------------------------------- |
| 配置文件 | 包含 mysql、etcd、minio、standalone 四个服务 |
| 启动成功 | 所有容器都在运行状态                         |
| 依赖理解 | 能解释 etcd、minio 的作用                    |
| 网络理解 | 能解释为什么用服务名就能通信                 |

**全部通过 → 进入【任务8】**

---

## 【任务8】NestJS 业务代码对接 Docker 中的 MySQL

**预计时间**：40~50 分钟

**学习目标**：

1. 用 TypeORM 连接 Docker 中的 MySQL
2. 实现一个完整的 CRUD 接口
3. 区分开发环境和生产环境的数据库配置

---

### 一、安装依赖

```bash
pnpm install --save @nestjs/typeorm typeorm mysql2
```

---

### 二、创建数据库实体

编辑 `src/book/entities/book.entity.ts`：

```typescript
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

@Entity({ name: "books" })
export class Book {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 255 })
  title: string;

  @Column({ length: 255 })
  author: string;

  @Column({ type: "text" })
  description: string;

  @Column({ type: "decimal", precision: 10, scale: 2 })
  price: number;

  @Column({ type: "int", default: 0 })
  stock: number;

  @Column({ type: "datetime" })
  publishedAt: Date;

  @CreateDateColumn({ type: "datetime" })
  createdAt: Date;

  @UpdateDateColumn({ type: "datetime" })
  updatedAt: Date;
}
```

---

### 三、配置数据库连接

编辑 `src/app.module.ts`：

```typescript
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { BookModule } from "./book/book.module";
import { Book } from "./book/entities/book.entity";

// 区分开发环境和生产环境
const isProduction = process.env.NODE_ENV === "production";

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: "mysql",
      // 开发环境用 localhost（Docker 外的 Node 直接连）
      // 生产环境用容器名 mysql（容器内通过 Docker 网络连接）
      host: isProduction ? "mysql" : "localhost",
      port: 3306,
      username: "root",
      password: "admin",
      database: "book",
      synchronize: true, // 自动同步表结构（开发环境方便，生产环境慎用）
      logging: true,
      entities: [Book],
    }),
    BookModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
```

---

### 四、启动并测试

#### 步骤1：确保 MySQL 容器在运行

```bash
npm run docker:up
```

#### 步骤2：启动 NestJS 开发服务器

```bash
npm run start:dev
```

#### 步骤3：测试接口

在另一个终端窗口执行：

```bash
# 新增书籍
curl -X POST "http://localhost:3000/book" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Clean Code",
    "author": "Robert C. Martin",
    "description": "A handbook of agile software craftsmanship",
    "price": 99.9,
    "stock": 50,
    "publishedAt": "2008-08-01"
  }'

# 查询全部书籍
curl -X GET "http://localhost:3000/book"
```

---

### 五、本任务验收清单

完成后，请把以下内容发给我：

1. 你的 `app.module.ts` 中 TypeORM 配置部分
2. 你的 `book.entity.ts` 完整内容
3. POST 创建书籍的 curl 命令和返回结果
4. GET 查询书籍的 curl 命令和返回结果
5. 回答：`synchronize: true` 是什么意思？生产环境为什么要慎用？

---

### 六、审批标准

| 检查项     | 标准                                           |
| ---------- | ---------------------------------------------- |
| 实体定义   | Book 实体包含所需字段，类型正确                |
| 数据库连接 | app.module.ts 正确配置 TypeORM                 |
| 环境区分   | host 根据 isProduction 区分 localhost 和 mysql |
| 接口测试   | POST 和 GET 请求都成功                         |
| 安全意识   | 理解 synchronize: true 生产环境的风险          |

**全部通过 → 进入【任务9】**

---

## 【任务9】生产环境编排 + 完整部署

**预计时间**：30~40 分钟

**学习目标**：

1. 编写生产环境的 docker-compose.yml
2. 让 Docker Compose 自动构建应用镜像
3. 实现一键部署：构建 + 启动数据库 + 启动应用

---

### 一、编写 docker-compose.prod.yml

在项目根目录创建 `docker-compose.prod.yml`：

```yaml
version: "3.8"

services:
  # 生产环境 MySQL
  mysql-prod:
    image: mysql:latest
    container_name: mysql-prod
    environment:
      MYSQL_ROOT_PASSWORD: admin
      MYSQL_DATABASE: book
    ports:
      - "3306:3306"
    command: mysqld --character-set-server=utf8mb4 --collation-server=utf8mb4_general_ci
    volumes:
      - ${DOCKER_VOLUME_DIRECTORY:-.}/volumes/mysql-prod:/var/lib/mysql
    restart: always

  # NestJS 应用
  nest-app:
    container_name: nest-app
    # 基于当前目录的 Dockerfile 自动构建镜像
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
    # 等 MySQL 启动后再启动应用
    depends_on:
      - mysql-prod
    restart: always
```

---

### 二、在 package.json 里封装命令

```json
{
  "scripts": {
    "docker:up": "docker-compose up -d",
    "docker:down": "docker-compose down",
    "docker:dev:up": "docker-compose -f docker-compose.dev.yml up -d",
    "docker:dev:down": "docker-compose -f docker-compose.dev.yml down",
    "docker:prod:up": "docker-compose -f docker-compose.prod.yml up -d --build",
    "docker:prod:down": "docker-compose -f docker-compose.prod.yml down",
    "build": "nest build",
    "start:dev": "nest start --watch"
  }
}
```

注意 `docker:prod:up` 加了 `--build`，每次启动前重新构建镜像，保证代码更新生效。

---

### 三、一键部署

```bash
# 停止开发环境（如果有在运行）
npm run docker:dev:down

# 生产环境一键部署（构建镜像 + 启动所有服务）
npm run docker:prod:up

# 查看状态
docker-compose -f docker-compose.prod.yml ps

# 查看应用日志
docker-compose -f docker-compose.prod.yml logs -f nest-app
```

---

### 四、验证部署

```bash
# 测试接口
curl http://localhost:3000

# 进入 MySQL 容器验证数据
docker exec -it mysql-prod mysql -uroot -padmin -e "SHOW DATABASES;"
```

---

### 五、完整项目结构回顾

```
nest-docker-test/
├── Dockerfile                    # 多阶段构建（生产）
├── Dockerfile2                   # 单阶段构建（开发/学习）
├── .dockerignore                 # 排除不需要的文件
├── docker-compose.yml            # 基础 Compose 配置
├── docker-compose.dev.yml        # 开发环境（MySQL + Milvus 全家桶）
├── docker-compose.prod.yml       # 生产环境（MySQL + NestJS 应用）
├── package.json
├── src/
│   ├── app.module.ts             # 数据库连接配置
│   ├── book/
│   │   └── entities/
│   │       └── book.entity.ts    # 数据库实体
│   └── ...
└── volumes/                      # 数据持久化目录（自动创建）
    ├── mysql/
    ├── mysql-prod/
    ├── etcd/
    ├── minio/
    └── milvus/
```

---

### 六、本任务验收清单（最终考核）

完成后，请把以下内容发给我：

1. 你的 `docker-compose.prod.yml` 完整内容
2. `docker-compose -f docker-compose.prod.yml ps` 的输出
3. `curl http://localhost:3000` 的返回结果
4. 回答以下问题：
   - `--build` 参数的作用是什么？
   - 开发环境和生产环境的 docker-compose 有什么区别？
   - 如果要添加 Redis 服务，应该写在哪个文件里？怎么写？

---

### 七、审批标准（最终考核）

| 检查项   | 标准                                           |
| -------- | ---------------------------------------------- |
| 生产配置 | docker-compose.prod.yml 包含 mysql 和 nest-app |
| 自动构建 | nest-app 使用 build 字段自动构建镜像           |
| 依赖关系 | nest-app 正确 depends_on mysql-prod            |
| 部署成功 | 两个容器都在运行，接口可达                     |
| 扩展思考 | 能描述如何添加 Redis 服务                      |

**全部通过 → 恭喜你完成全部 Docker 学习任务！** 🎉

---

## 附录：完整命令速查表

### 镜像命令

```bash
docker images                    # 查看所有镜像
docker rmi 镜像ID                # 删除镜像
docker build -t 名字:标签 .      # 构建镜像
docker pull 镜像名               # 拉取镜像
docker push 用户名/镜像名        # 推送镜像
```

### 容器命令

```bash
docker ps                        # 查看运行中的容器
docker ps -a                     # 查看所有容器
docker run [选项] 镜像名         # 运行容器
docker start 容器名              # 启动容器
docker stop 容器名               # 停止容器
docker rm 容器名                 # 删除容器
docker logs 容器名               # 查看日志
docker logs -f 容器名            # 持续跟踪日志
docker exec -it 容器名 bash      # 进入容器
docker cp 本地文件 容器名:路径   # 复制文件到容器
```

### Docker Compose 命令

```bash
docker-compose up -d             # 启动所有服务
docker-compose down              # 停止并删除
docker-compose ps                # 查看状态
docker-compose logs -f 服务名    # 查看日志
docker-compose restart 服务名    # 重启服务
```

### 清理命令

```bash
docker container prune           # 删除已停止的容器
docker image prune               # 删除未使用的镜像
docker volume prune              # 删除未使用的卷
docker system prune -a           # 一键清理所有
```
