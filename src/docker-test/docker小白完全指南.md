# Docker 小白完全指南 —— 从入门到部署后端服务

> 本教程结合 `nest-dockerfile-test` 项目中的真实代码，手把手教你用 Docker 打包和部署后端应用，以及一键配置完整的后端开发环境。

---

## 目录

1. [Docker 是什么](#1-docker-是什么)
2. [安装 Docker](#2-安装-docker)
3. [核心概念：镜像、容器、仓库](#3-核心概念镜像容器仓库)
4. [实战第一步：写一个最简单的 Dockerfile](#4-实战第一步写一个最简单的-dockerfile)
5. [实战第二步：多阶段构建优化镜像](#5-实战第二步多阶段构建优化镜像)
6. [排除不需要的文件：.dockerignore](#6-排除不需要的文件dockerignore)
7. [实战第三步：Docker Compose 一键启动后端环境](#7-实战第三步docker-compose-一键启动后端环境)
8. [常用命令速查表](#8-常用命令速查表)
9. [完整实战：NestJS 项目 Docker 化全流程](#9-完整实战nestjs-项目-docker-化全流程)
10. [扩展知识](#10-扩展知识)

---

## 1. Docker 是什么

### 1.1 用生活化的语言理解

想象你开发了一个 Node.js 后端项目，在你的电脑上能跑，但换到另一台电脑就报错：

- "我这边 Node 版本是 18，你那边是 16，不兼容"
- "我安装了 Python 依赖，你没装"
- "Windows 上能跑，Linux 服务器上跑不了"

**Docker 就是来解决这个问题的。**

它把 **你的代码 + 运行环境 + 系统依赖** 打包成一个「集装箱」（镜像）。无论把这个集装箱搬到哪台机器上，里面东西一模一样，开箱即用。

### 1.2 关键比喻

| 现实概念         | Docker 概念      | 说明                               |
| ---------------- | ---------------- | ---------------------------------- |
| 集装箱模板       | 镜像 (Image)     | 只读的模板，包含运行应用所需的一切 |
| 正在运行的集装箱 | 容器 (Container) | 镜像的实例，真正在跑的进程         |
| 集装箱仓库       | 仓库 (Registry)  | 存放镜像的地方，如 Docker Hub      |
| 码头工人         | Docker Engine    | 管理镜像和容器的后台服务           |

---

## 2. 安装 Docker

### 2.1 Windows 安装

1. 访问 https://www.docker.com/products/docker-desktop
2. 下载 Docker Desktop for Windows
3. 安装后重启电脑
4. 打开 Docker Desktop，左下角显示 **Docker Engine running** 即为成功

### 2.2 验证安装

打开 PowerShell 或 Git Bash，执行：

```bash
docker --version
# 输出类似：Docker version 26.0.0, build 2ae903e

docker run hello-world
# 如果看到 "Hello from Docker!"，说明安装成功
```

---

## 3. 核心概念：镜像、容器、仓库

### 3.1 镜像 (Image)

镜像是一个**只读模板**，类似于虚拟机的快照。它包含了：

- 基础操作系统（如 Alpine Linux）
- 运行时环境（如 Node.js）
- 你的应用程序代码
- 依赖库和配置文件

### 3.2 容器 (Container)

容器是镜像的**运行实例**。你可以：

- 从一个镜像启动多个容器
- 每个容器相互隔离，互不干扰
- 容器可以被启动、停止、删除

```bash
# 从镜像启动一个容器
docker run -d -p 3000:3000 --name my-app my-image

# 查看运行中的容器
docker ps

# 停止容器
docker stop my-app

# 删除容器
docker rm my-app
```

### 3.3 仓库 (Registry)

仓库用来存储和分发镜像。最常见的是 **Docker Hub**（https://hub.docker.com）。

```bash
# 从 Docker Hub 拉取官方 Node.js 镜像
docker pull node:24.15-alpine

# 推送自己的镜像到仓库（需先登录）
docker push yourname/your-image:tag
```

---

## 4. 实战第一步：写一个最简单的 Dockerfile

### 4.1 什么是 Dockerfile

Dockerfile 是一个**文本文件**，里面写了一系列指令，告诉 Docker 如何一步步构建镜像。

### 4.2 单阶段 Dockerfile（适合初学者理解）

这是我们项目中的 `Dockerfile2`，逻辑最简单：

```dockerfile
# ============================================
# 单阶段构建 Dockerfile
# 职责：把 NestJS 项目打包成可运行的 Docker 镜像
# 适用场景：开发环境、快速验证、学习理解
# ============================================

# 1. 指定基础镜像（必须第一行）
#    node:24.15-alpine 表示基于 Node.js 24.15 版本，Alpine 是一个超小的 Linux 发行版（只有 5MB）
FROM node:24.15-alpine

# 2. 设置容器内工作目录
#    后续所有操作都在 /app 目录下进行
WORKDIR /app

# 3. 先复制 package.json 和 package-lock.json
#    为什么要先复制这两个文件？
#    因为 Docker 有缓存机制：如果这两个文件没变，npm install 就不会重新执行
#    这样代码修改后重新构建会快很多
COPY package*.json ./

# 4. 构建时执行：安装依赖
#    设置国内 npm 镜像源，加速下载
RUN npm config set registry https://registry.npmmirror.com/
RUN npm install
#    全局安装 NestJS CLI，用于编译项目
RUN npm install -g @nestjs/cli

# 5. 复制项目所有代码到容器内
COPY . .

# 6. 构建 Nest 项目（把 TypeScript 编译成 JavaScript）
RUN npm run build

# 7. 声明暴露端口（仅声明，不实际映射）
#    告诉使用者这个容器会监听 3000 端口
EXPOSE 3000

# 8. 容器启动时执行的命令
#    运行编译后的入口文件
CMD ["node", "dist/main.js"]
```

### 4.3 逐行解释关键指令

| 指令      | 作用                 | 注意点                                    |
| --------- | -------------------- | ----------------------------------------- |
| `FROM`    | 指定基础镜像         | 必须作为 Dockerfile 的第一条指令          |
| `WORKDIR` | 设置工作目录         | 如果不存在会自动创建                      |
| `COPY`    | 复制本地文件到容器   | 第一个路径是宿主机，第二个是容器内        |
| `RUN`     | 构建时执行命令       | 每行 RUN 会创建一层镜像层，层越多镜像越大 |
| `EXPOSE`  | 声明暴露的端口       | 只是文档说明，实际映射用 `-p` 参数        |
| `CMD`     | 容器启动时执行的命令 | 只能有一条，如果多条只有最后一条生效      |

### 4.4 构建并运行

```bash
# 进入项目目录
cd nest-dockerfile-test

# 构建镜像（-t 指定镜像名和标签）
docker build -f Dockerfile2 -t my-nest-app:v1 .

# 查看构建好的镜像
docker images

# 运行容器
# -d: 后台运行
# -p 3000:3000: 把宿主机的 3000 端口映射到容器的 3000 端口
# --name: 给容器起个名字
docker run -d -p 3000:3000 --name my-nest-app my-nest-app:v1

# 查看容器日志
docker logs my-nest-app

# 测试访问
curl http://localhost:3000
```

---

## 5. 实战第二步：多阶段构建优化镜像

### 5.1 单阶段的问题

上面的 `Dockerfile2` 有一个问题：**镜像太大了**。

因为它把开发依赖（如 `@nestjs/cli`、`typescript`）也打包进去了，而这些在生产环境根本用不到。

### 5.2 多阶段构建（生产环境推荐）

这是我们项目中的 `Dockerfile`，采用**多阶段构建**：

```dockerfile
# ============================================
# 多阶段构建 Dockerfile
# 职责：构建阶段编译代码，运行阶段只保留生产必需文件
# 优势：镜像体积极小，安全性更高
# 适用场景：生产环境部署
# ============================================

# --------------------------------------------
# 阶段一：builder（构建阶段）
# --------------------------------------------
# 需要 devDependencies（含 @nestjs/cli、typescript）才能 nest build
FROM node:24.15-alpine AS builder

WORKDIR /app

COPY package*.json ./

RUN npm config set registry https://registry.npmmirror.com/
RUN npm install

COPY . .

# 编译项目：TS → JS
RUN npm run build

# --------------------------------------------
# 阶段二：production（运行阶段）
# --------------------------------------------
# 仅保留生产依赖 + 编译产物，镜像更小
FROM node:24.15-alpine

# 设置环境变量为生产模式
ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./

RUN npm config set registry https://registry.npmmirror.com/
# --production 表示只安装 dependencies，不装 devDependencies
RUN npm install --production

# 从 builder 阶段复制编译产物
# --from=builder 表示从名为 builder 的阶段复制文件
COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/main.js"]
```

### 5.3 多阶段构建的原理

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

### 5.4 对比

| 维度     | 单阶段 (Dockerfile2)     | 多阶段 (Dockerfile) |
| -------- | ------------------------ | ------------------- |
| 镜像大小 | 大（含 devDependencies） | 小（仅生产依赖）    |
| 构建时间 | 较短                     | 稍长（两个阶段）    |
| 安全性   | 低（多余工具暴露攻击面） | 高                  |
| 适用场景 | 开发环境                 | 生产环境            |

### 5.5 构建多阶段镜像

```bash
# 构建（不需要指定 -f，因为默认就是 Dockerfile）
docker build -t my-nest-app:prod .

# 对比镜像大小
docker images | grep my-nest-app

# 运行
docker run -d -p 3000:3000 --name my-nest-prod my-nest-app:prod
```

---

## 6. 排除不需要的文件：.dockerignore

### 6.1 为什么要用 .dockerignore

在 `COPY . .` 时，Docker 会把当前目录**所有文件**都复制进容器。但有些东西不需要：

- `node_modules/`：容器内会重新安装，复制进去浪费空间
- `.git/`：版本控制文件，运行时不需
- `.vscode/`：编辑器配置

### 6.2 项目中的 .dockerignore

```
node_modules/
.vscode/
.git/
```

### 6.3 更完善的 .dockerignore 示例

```
# 依赖目录（容器内会重新安装）
node_modules/
npm-debug.log
yarn-error.log
pnpm-debug.log

# 版本控制
.git/
.gitignore

# 编辑器配置
.vscode/
.idea/
*.swp
*.swo

# 测试文件
test/
coverage/
*.spec.ts
*.test.ts

# 本地环境文件（可能包含敏感信息）
.env
.env.local
.env.*.local

# 文档和无关文件
README.md
*.md
.dockerignore
Dockerfile*
docker-compose*.yml
```

---

## 7. 实战第三步：Docker Compose 一键启动后端环境

### 7.1 什么是 Docker Compose

开发一个后端项目，通常需要多个服务配合：

- 你的 NestJS 应用
- MySQL 数据库
- Redis 缓存
- Milvus 向量数据库

**手动一个个启动太麻烦了。**

Docker Compose 允许你用**一个 YAML 文件**定义所有服务，然后**一条命令**全部启动。

### 7.2 项目中的 docker-compose.dev.yml

这是完整的开发环境配置，包含 **MySQL + Milvus 向量数据库**：

```yaml
# ============================================
# Docker Compose 开发环境配置
# 职责：一键启动后端所需的全部基础设施服务
# 使用方式：docker-compose -f docker-compose.dev.yml up -d
# ============================================

version: "3.8"

services:
  # ------------------------------------------
  # 服务1：MySQL 数据库
  # ------------------------------------------
  mysql:
    # 使用官方 MySQL 最新镜像
    image: mysql:latest
    # 容器名字，方便后续用 docker exec 进入
    container_name: mysql-dev
    # 端口映射：宿主机 3306 → 容器 3306
    ports:
      - "3306:3306"
    # 环境变量：设置 root 密码和默认数据库
    environment:
      MYSQL_ROOT_PASSWORD: admin
      MYSQL_DATABASE: book
    # 自定义启动命令：设置字符集为 utf8mb4（支持中文和 emoji）
    command: mysqld --character-set-server=utf8mb4 --collation-server=utf8mb4_general_ci
    # 数据持久化：把容器内的数据映射到宿主机，防止容器删除后数据丢失
    volumes:
      - ${DOCKER_VOLUME_DIRECTORY:-.}/volumes/mysql:/var/lib/mysql
    # 总是自动重启
    restart: always

  # ------------------------------------------
  # 服务2：etcd（Milvus 的依赖，服务发现）
  # ------------------------------------------
  etcd:
    container_name: milvus-etcd
    image: quay.io/coreos/etcd:v3.5.18
    environment:
      - ETCD_AUTO_COMPACTION_MODE=revision
      - ETCD_AUTO_COMPACTION_RETENTION=1000
      - ETCD_QUOTA_BACKEND_BYTES=4294967296
      - ETCD_SNAPSHOT_COUNT=50000
    volumes:
      - ${DOCKER_VOLUME_DIRECTORY:-.}/volumes/etcd:/etcd
    command: etcd -advertise-client-urls=http://etcd:2379 -listen-client-urls http://0.0.0.0:2379 --data-dir /etcd
    # 健康检查：确保 etcd 启动成功后再启动依赖它的服务
    healthcheck:
      test: ["CMD", "etcdctl", "endpoint", "health"]
      interval: 30s
      timeout: 20s
      retries: 3

  # ------------------------------------------
  # 服务3：MinIO（Milvus 的依赖，对象存储）
  # ------------------------------------------
  minio:
    container_name: milvus-minio
    image: minio/minio:RELEASE.2024-05-28T17-19-04Z
    environment:
      MINIO_ACCESS_KEY: minioadmin
      MINIO_SECRET_KEY: minioadmin
    ports:
      - "9001:9001" # MinIO 控制台
      - "9000:9000" # S3 API 端口
    volumes:
      - ${DOCKER_VOLUME_DIRECTORY:-.}/volumes/minio:/minio_data
    command: minio server /minio_data --console-address ":9001"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 30s
      timeout: 20s
      retries: 3

  # ------------------------------------------
  # 服务4：Milvus 向量数据库
  # ------------------------------------------
  standalone:
    container_name: milvus-standalone
    image: milvusdb/milvus:v2.5.25
    command: ["milvus", "run", "standalone"]
    security_opt:
      - seccomp:unconfined
    environment:
      MINIO_REGION: us-east-1
      ETCD_ENDPOINTS: etcd:2379
      MINIO_ADDRESS: minio:9000
    volumes:
      - ${DOCKER_VOLUME_DIRECTORY:-.}/volumes/milvus:/var/lib/milvus
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9091/healthz"]
      interval: 30s
      start_period: 90s
      timeout: 20s
      retries: 3
    ports:
      - "19530:19530" # Milvus gRPC 端口
      - "9091:9091" # Milvus  metrics 端口
    # depends_on 确保 etcd 和 minio 先启动
    depends_on:
      - "etcd"
      - "minio"

# 所有服务共用同一个网络，可以通过容器名互相访问
networks:
  default:
    name: common-network
```

### 7.3 关键配置解读

#### 7.3.1 端口映射

```yaml
ports:
  - "3306:3306"
```

格式为 `宿主机端口:容器端口`。这样你可以通过 `localhost:3306` 访问容器内的 MySQL。

#### 7.3.2 数据持久化（volumes）

```yaml
volumes:
  - ${DOCKER_VOLUME_DIRECTORY:-.}/volumes/mysql:/var/lib/mysql
```

**为什么要做持久化？**

容器是临时的，删除后数据就没了。通过 volumes 把容器内的数据目录映射到宿主机，即使容器删除，数据还在。

`${DOCKER_VOLUME_DIRECTORY:-.}` 表示：

- 如果有 `DOCKER_VOLUME_DIRECTORY` 环境变量，就用它的值
- 否则用当前目录 `.`

#### 7.3.3 服务依赖（depends_on）

```yaml
depends_on:
  - "etcd"
  - "minio"
```

这确保 Milvus 启动前，etcd 和 minio 已经先启动了。

**注意**：`depends_on` 只保证启动顺序，不保证服务完全就绪。所以上面配置了 `healthcheck` 来做健康检查。

#### 7.3.4 容器间通信

在同一个 Docker Compose 网络中，容器可以通过**服务名**互相访问：

```yaml
# Milvus 配置中
environment:
  ETCD_ENDPOINTS: etcd:2379 # etcd 就是服务名
  MINIO_ADDRESS: minio:9000 # minio 就是服务名
```

不需要写 IP 地址，Docker 会自动解析。

### 7.4 常用 Docker Compose 命令

```bash
# 启动所有服务（-d 表示后台运行）
docker-compose -f docker-compose.dev.yml up -d

# 查看运行状态
docker-compose -f docker-compose.dev.yml ps

# 查看日志（-f 表示持续跟踪）
docker-compose -f docker-compose.dev.yml logs -f mysql

# 停止所有服务
docker-compose -f docker-compose.dev.yml stop

# 停止并删除容器、网络
docker-compose -f docker-compose.dev.yml down

# 停止并删除容器 + 卷（会清空数据，慎用！）
docker-compose -f docker-compose.dev.yml down -v

# 重启某个服务
docker-compose -f docker-compose.dev.yml restart mysql

# 进入容器内部（如进入 MySQL 容器执行命令）
docker exec -it mysql-dev bash
# 然后登录 MySQL
mysql -uroot -padmin
```

---

## 8. 常用命令速查表

### 8.1 镜像相关

```bash
# 查看所有镜像
docker images

# 删除镜像
docker rmi 镜像ID

# 构建镜像（-t 指定名字，. 表示当前目录）
docker build -t 名字:标签 .

# 从 Dockerfile2 构建
docker build -f Dockerfile2 -t 名字:标签 .

# 给镜像打标签
docker tag 原镜像:标签 新镜像:标签

# 推送镜像到仓库
docker push 用户名/镜像名:标签

# 拉取镜像
docker pull 镜像名:标签
```

### 8.2 容器相关

```bash
# 查看运行中的容器
docker ps

# 查看所有容器（包括已停止的）
docker ps -a

# 启动容器
docker start 容器名/ID

# 停止容器
docker stop 容器名/ID

# 强制停止
docker kill 容器名/ID

# 删除容器
docker rm 容器名/ID

# 强制删除运行中的容器
docker rm -f 容器名/ID

# 查看容器日志
docker logs 容器名/ID

# 持续跟踪日志
docker logs -f 容器名/ID

# 进入容器内部
docker exec -it 容器名/ID bash
# 如果容器没有 bash，用 sh
docker exec -it 容器名/ID sh

# 复制文件：宿主机 → 容器
docker cp 本地文件 容器名:/容器内路径

# 复制文件：容器 → 宿主机
docker cp 容器名:/容器内路径 本地路径
```

### 8.3 清理相关

```bash
# 删除所有停止的容器
docker container prune

# 删除所有未使用的镜像
docker image prune

# 删除所有未使用的卷
docker volume prune

# 一键清理所有未使用的东西（容器、镜像、卷、网络）
docker system prune -a
```

---

## 9. 完整实战：NestJS 项目 Docker 化全流程

### 9.1 项目结构

```
nest-dockerfile-test/
├── Dockerfile              # 多阶段构建（生产环境）
├── Dockerfile2             # 单阶段构建（开发环境）
├── .dockerignore           # 排除不需要的文件
├── docker-compose.dev.yml  # 开发环境基础设施
├── package.json
├── src/
└── ...
```

### 9.2 步骤一：准备 .dockerignore

```
node_modules/
.vscode/
.git/
dist/           # 如果存在旧的编译产物，也忽略
```

### 9.3 步骤二：编写 Dockerfile（生产环境）

见第 5 节的 `Dockerfile` 内容。

### 9.4 步骤三：构建并测试镜像

```bash
# 1. 构建镜像
docker build -t nest-app:prod .

# 2. 运行容器
docker run -d \
  -p 3000:3000 \
  --name nest-prod \
  nest-app:prod

# 3. 检查是否正常运行
docker ps
docker logs nest-prod

# 4. 测试接口
curl http://localhost:3000

# 5. 停止并删除
docker stop nest-prod
docker rm nest-prod
```

### 9.5 步骤四：启动后端依赖环境

```bash
# 启动 MySQL + Milvus
docker-compose -f docker-compose.dev.yml up -d

# 检查状态
docker-compose -f docker-compose.dev.yml ps

# 测试 MySQL 连接
docker exec -it mysql-dev mysql -uroot -padmin -e "SHOW DATABASES;"

# 测试 Milvus 连接（需要安装 milvus-cli 或用 sdk）
```

### 9.6 步骤五：完整启动（应用 + 基础设施）

如果你希望用 Docker Compose 同时管理应用和基础设施，可以再加一个 `docker-compose.yml`：

```yaml
version: "3.8"

services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: nest-app
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - DB_HOST=mysql
      - DB_PORT=3306
      - DB_USER=root
      - DB_PASSWORD=admin
      - DB_NAME=book
      - MILVUS_HOST=standalone
      - MILVUS_PORT=19530
    depends_on:
      - mysql
      - standalone

  mysql:
    image: mysql:latest
    container_name: mysql-dev
    ports:
      - "3306:3306"
    environment:
      MYSQL_ROOT_PASSWORD: admin
      MYSQL_DATABASE: book
    volumes:
      - ./volumes/mysql:/var/lib/mysql

  # ... etcd、minio、standalone 同 docker-compose.dev.yml
```

启动命令：

```bash
docker-compose up -d
```

---

## 10. 扩展知识

### 10.1 Alpine vs Debian：基础镜像的选择

| 基础镜像              | 大小   | 适用场景                   |
| --------------------- | ------ | -------------------------- |
| `node:24.15-alpine`   | ~40MB  | 生产环境，追求最小体积     |
| `node:24.15-slim`     | ~60MB  | 折中选择，需要一些基础工具 |
| `node:24.15` (Debian) | ~200MB | 开发环境，工具齐全         |

**Alpine** 是一个轻量级 Linux 发行版，使用 `musl libc` 而不是 `glibc`。某些依赖 glibc 的应用可能会有兼容性问题，但对 Node.js 项目通常没问题。

### 10.2 镜像分层与缓存机制

Docker 镜像是由**多层（layer）**组成的，每条指令创建一层：

```
FROM node:alpine      → Layer 1: 基础镜像（只读，已缓存）
WORKDIR /app          → Layer 2
COPY package*.json    → Layer 3（只有 package.json 变时才重建）
RUN npm install       → Layer 4（只有 Layer 3 变时才重建）
COPY . .              → Layer 5（代码变了就要重建）
RUN npm run build     → Layer 6
```

**优化技巧**：把变化频率低的指令放前面，变化频率高的放后面，最大化利用缓存。

### 10.3 ENV 环境变量

```dockerfile
ENV NODE_ENV=production
ENV PORT=3000
```

也可以在运行容器时覆盖：

```bash
docker run -e NODE_ENV=development -e PORT=8080 my-app
```

### 10.4 健康检查（HEALTHCHECK）

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1
```

Docker 会定期执行这个命令，如果连续失败 3 次，就会标记容器为 `unhealthy`。

### 10.5 非 root 用户运行（安全最佳实践）

```dockerfile
FROM node:24.15-alpine

# 创建非 root 用户
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001

WORKDIR /app
COPY --chown=nodejs:nodejs . .
USER nodejs

EXPOSE 3000
CMD ["node", "dist/main.js"]
```

以 root 运行容器有安全风险，生产环境建议创建专用用户。

### 10.6 .env 文件与 Docker

不要在 Dockerfile 中写死敏感信息（密码、密钥）。推荐使用环境变量：

```bash
# 方式1：命令行传入
docker run -e DB_PASSWORD=secret my-app

# 方式2：使用 .env 文件
docker run --env-file .env my-app

# 方式3：Docker Compose 自动读取 .env
docker-compose up -d
```

---

## 总结

| 阶段    | 你学会了什么                           |
| ------- | -------------------------------------- |
| 第1-3节 | Docker 是什么、怎么安装、核心概念      |
| 第4节   | 写单阶段 Dockerfile，理解每条指令      |
| 第5节   | 多阶段构建优化，大幅减小镜像体积       |
| 第6节   | 用 .dockerignore 排除不需要的文件      |
| 第7节   | 用 Docker Compose 一键启动完整后端环境 |
| 第8节   | 常用命令速查                           |
| 第9节   | 完整的 NestJS Docker 化部署流程        |
| 第10节  | 进阶知识：镜像选择、分层缓存、安全实践 |

现在，你可以：

1. 把一个 Node.js 项目打包成 Docker 镜像
2. 用多阶段构建优化镜像大小
3. 用 Docker Compose 一键启动 MySQL + Milvus 等后端依赖
4. 排查和解决常见的 Docker 问题

**下一步建议**：

- 尝试修改 Dockerfile，换不同的基础镜像（如 slim），对比构建后的体积
- 在 docker-compose.dev.yml 中添加 Redis 服务
- 学习 Docker 网络，实现容器间的更复杂通信
