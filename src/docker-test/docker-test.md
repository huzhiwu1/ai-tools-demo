# 基于 Docker Compose 的本地开发提效和生产环境部署

**作者** ：神光的幸福生活

**发布时间** ：2026 年 4 月 25 日

**适用方向** ：AI Agent 后端开发、Nest.js 容器化部署

## 一、AI Agent 后端技术栈整体认知

AI Agent 业务逻辑均运行在后端，主流 Agent 岗位也以后端开发为主，因此做 Agent 开发必须掌握后端技术生态。

### 1. 数据库与中间件定位区分

整套架构核心分为 **数据库** 、 **中间件** 、**业务代码**三部分：

表格

| 分类   | 定位                  | 核心作用                                             | 典型组件                                                                                                    |
| ------ | --------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 数据库 | 业务「压舱石 / 仓库」 | 持久化原始业务数据，保障数据绝对可靠、不丢失         | MySQL（业务主数据）                                                                                         |
| 中间件 | 专项「特种兵」        | 补足数据库短板，提供单一高性能能力，不负责通用持久化 | Redis（缓存 / 分布式锁）、Elasticsearch（全文检索）、Milvus（向量 / 语义检索）、BullMQ/RabbitMQ（消息队列） |

#### 细分能力补足场景

1. **检索补足** ：MySQL 不擅长全文模糊搜索，使用 Elasticsearch 做高性能全文检索；
2. **性能补足** ：数据库磁盘读写慢，使用 Redis 做内存级高速缓存；
3. **异步补足** ：业务流程耗时过长，使用消息队列做任务缓冲、异步解耦。

### 2. 全栈 AI Agent 后端架构分层

1. **用户终端层** ：网页端、移动端应用；
2. **应用程序与中间件层** ：Nest.js 业务服务 + Redis、Elasticsearch、Milvus、BullMQ；
3. **数据与基础设施层** ：MySQL（唯一关系型数据底座，存储原始数据）。

> 核心逻辑：MySQL 是数据根基；各类中间件各司其职，临时数据丢失不影响业务完整性； **业务代码是调度中心** ，统一整合所有底层组件，也是进阶后端架构师的核心能力。

## 二、Docker 基础概念

数据库、中间件、业务服务统一使用 Docker 运行，实现环境统一、部署便捷。

### 1. 核心概念

- **镜像（Image）** ：将应用 + 依赖环境封装的静态模板；
- **容器（Container）** ：镜像运行后的实例，一台服务器可运行多个容器；
- **容器特性** ：相互隔离，拥有独立文件系统、网络、端口，互不干扰；
- **Docker Hub** ：官方镜像仓库，可拉取公共镜像、推送自定义镜像。

### 2. 核心组件交互流程

`Client` → `Docker daemon（引擎）` ↔ `Registry（Docker Hub）`

常用命令动作：

- `docker pull`：从仓库拉取镜像；
- `docker build`：本地构建自定义镜像；
- `docker run`：基于镜像启动容器。

### 3. 容器运行核心参数说明

以 MySQL 容器启动为例，可视化配置与命令行参数一一对应：

1. **`--name`** ：自定义容器名称；
2. **`-p 宿主机端口:容器端口`** ：端口映射，外部通过宿主机端口访问容器服务；
3. **`-e 环境变量`** ：配置容器内应用参数（如 MySQL 密码）；
4. **`-v 宿主机目录:容器目录`（Volume 数据卷）** ： **数据持久化** ，将容器内数据挂载到宿主机，删除容器数据不丢失。

#### 完整命令行示例

运行

```bash
docker run -d\
--name mysql-container2\
-p 3306:3306\
-e MYSQL_ROOT_PASSWORD=admin \
-v /Users/guang/mysql:/var/lib/mysql
mysql:latest
```

## 三、Dockerfile 构建自定义镜像（Nest.js 项目）

想要将自研 Nest 项目打包为 Docker 镜像，需要编写 `Dockerfile`，同时搭配 `.dockerignore` 忽略无用文件。

### 1. 基础前置操作

1. 创建 Nest 项目

运行

```bash
nest new nest-dockerfile-test
cd nest-dockerfile-test
```

2. 生成 CRUD 模块（书籍模块）

运行

```bash
nest g res book --no-spec
```

3. 创建 `.dockerignore`（构建镜像时忽略文件）

plaintext

```
node_modules/
.vscode/
.git/
```

### 2. 基础版 Dockerfile

dockerfile

```yml
# 指定基础镜像（第一行必须为FROM）
FROM node:24.15-alpine
# 设置容器内工作目录
WORKDIR /app
# 分步复制依赖，利用镜像缓存加速构建
COPY package*.json ./
# 切换npm镜像、安装依赖
RUN npm config set registry https://registry.npmmirror.com/
RUN npm install
RUN npm install -g @nestjs/cli
# 复制全部项目代码
COPY . .
# 编译Nest项目
RUN npm run build
# 声明暴露端口（仅注释作用，不会实际开启端口）
EXPOSE 3000
# 容器启动执行命令（一个Dockerfile仅允许一个CMD）
CMD ["node", "dist/main.js"]
```

#### 指令释义

- `FROM`：指定基础镜像；
- `WORKDIR`：容器内工作目录；
- `COPY`：宿主机文件复制到容器；
- `RUN`：**构建镜像阶段**执行命令；
- `EXPOSE`：声明服务端口；
- `CMD`：**容器启动阶段**执行默认命令。

### 3. 镜像构建 & 容器运行

运行

```bash
# 构建镜像 -t 指定镜像名称
docker build -t nest-app .

# 启动容器
docker run -d\
--name nest-container\
-p 3006:3000\
nest-app
```

### 4. 多阶段构建（镜像体积优化）

基础版镜像会包含源码、开发依赖，体积庞大。**多阶段构建**拆分「构建阶段」和「运行阶段」，仅保留运行时依赖，大幅缩减镜像大小。

#### 优化后 Dockerfile

dockerfile

```
# 阶段1：构建阶段（包含开发依赖，仅用于编译代码）
FROM node:24.15-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm config set registry https://registry.npmmirror.com/
RUN npm install
COPY . .
RUN npm run build

# 阶段2：运行阶段（仅保留生产依赖+编译产物，最终镜像）
FROM node:24.15-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm config set registry https://registry.npmmirror.com/
# 仅安装生产依赖
RUN npm install --production
# 从构建阶段复制编译后的代码
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

> 效果：镜像体积减少约 400M，是生产环境标准写法。

## 四、Docker Compose 容器编排

`Docker Compose` 用于 **批量管理多个容器** ，统一配置启动参数、依赖顺序、网络，所有容器默认互通，可通过**容器名**互相访问。

### 1. 本地开发环境配置（docker-compose.dev.yml）

整合 MySQL、Milvus 整套中间件，一键启动所有服务。

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
      # 容器启动自动创建数据库
      MYSQL_DATABASE: book
    # 设置MySQL字符集
    command: mysqld --character-set-server=utf8mb4 --collation-server=utf8mb4_general_ci
    volumes:
      # 环境变量优先，无则使用当前目录volumes
      - ${DOCKER_VOLUME_DIRECTORY:-.}/volumes/mysql:/var/lib/mysql
    restart: always

  # Milvus 依赖：etcd
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
    command: etcd -advertise-client-urls=http://etcd:2379 -listen-client-urls=http://0.0.0.0:2379
    healthcheck:
      test: ["CMD", "etcdctl", "endpoint", "health"]
      interval: 30s
      timeout: 20s
      retries: 3

  # Milvus 依赖：minio
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

  # 主服务：Milvus 向量库
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
      - "19530:19530"
      - "9091:9091"
    # 依赖前置服务，顺序启动
    depends_on:
      - "etcd"
      - "minio"

networks:
  default:
    name: common-network
```

#### 配置说明

- `${DOCKER_VOLUME_DIRECTORY:-.}`：环境变量取值，未配置则默认当前目录，灵活指定数据卷路径；
- `depends_on`：控制容器启动顺序，等待依赖服务就绪后再启动当前容器；
- `restart: always`：容器异常自动重启。

### 2. 本地启动脚本（package.json）

在项目脚本中封装命令，简化操作：

```json
"scripts": {
  "docker:up": "DOCKER_VOLUME_DIRECTORY=/Users/guang/ docker compose -f docker-compose.dev.yml up -d",
  "docker:down": "docker compose -f docker-compose.dev.yml down",
  "build": "nest build",
  "start:dev": "nest start --watch"
}
```

执行命令：

运行

```bash
# 启动所有容器（后台运行）
npm run docker:up
# 停止所有容器
npm run docker:down
```

## 五、Nest.js + MySQL 业务代码开发

基于 TypeORM 实现书籍模块 CRUD，对接 Docker 中的 MySQL 服务。

### 1. 安装依赖

bash

运行

```bash
pnpm install --save @nestjs/typeorm typeorm mysql2
pnpm install @nestjs/serve-static
```

### 2. 数据库实体（book.entity.ts）

typescript

运行

```
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'books' })
export class Book {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 255 })
  title: string;

  @Column({ length: 255 })
  author: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  price: number;

  @Column({ type: 'int', default: 0 })
  stock: number;

  @Column({ type: 'datetime' })
  publishedAt: Date;

  @CreateDateColumn({ type: 'datetime' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt: Date;
}
```

### 3. 模块配置（app.module.ts）

区分**开发环境**和**生产环境**数据库连接地址：

typescript

运行

```
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BookModule } from './book/book.module';
import { Book } from './book/entities/book.entity';

const isProduction = process.env.NODE_ENV === 'production';

@Module({
  imports: [
    // 静态资源托管
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, 'public'),
      serveRoot: '/books'
    }),
    // TypeORM 数据库连接
    TypeOrmModule.forRoot({
      type: 'mysql',
      // 开发用localhost，生产用容器名mysql-prod
      host: isProduction ? 'mysql-prod' : 'localhost',
      port: 3306,
      username: 'root',
      password: 'admin',
      database: 'book',
      synchronize: true,
      connectorPackage: 'mysql2',
      logging: true,
      autoLoadEntities: true,
      entities: [Book],
    }),
    BookModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
```

### 4. 静态资源打包配置（nest-cli.json）

配置 Nest 编译时同步 `public` 静态目录到 `dist`：

json

```
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true,
    "assets": [
      {
        "include": "../public/**/*",
        "outDir": "dist/public"
      }
    ]
  }
}
```

### 5. 前端静态页面（public/index.html）

简易书籍管理页面，实现增删改查交互（代码略，文档内为完整页面代码）。

### 6. 接口测试命令

bash

运行

```
# 新增书籍
curl -X POST "http://localhost:3000/book" \
-H "Content-Type: application/json"\
-d'{
"title":"Clean Code",
"author":"Robert C.Martin",
"description": "A handbook of agile software craftsmanship",
"price": 99.9,
"stock":50,
"publishedAt":"2008-08-01"
}'

# 查询全部书籍
curl -X GET "http://localhost:3000/book"
```

## 六、生产环境 Docker Compose 配置（docker-compose.prod.yml）

生产环境编排 MySQL + Nest 应用，自动构建镜像、容器依赖启动。

yaml

```
services:
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

  nest-app:
    container_name: nest-app
    # 基于当前目录Dockerfile自动构建镜像
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
    # 依赖MySQL，先启动数据库再启动应用
    depends_on:
      - mysql-prod
    restart: always
```

### 生产环境启动脚本（package.json）

json

```
"scripts": {
  "docker:prod:up": "docker compose -f docker-compose.prod.yml up -d --build"
}
```

执行：

bash

运行

```
npm run docker:prod:up
```

- `--build`：每次启动前重新构建镜像，保证代码更新生效。

## 七、总结

1. **架构分层** ：MySQL 为核心数据底座，各类中间件负责专项能力，业务代码统一调度；
2. **Docker 核心** ：镜像封装环境，容器实现隔离，Volume 保障数据持久化；
3. **Dockerfile** ：基础镜像构建 + 多阶段构建优化镜像体积；
4. **Docker Compose** ：本地开发一键启停多容器，生产环境统一编排部署；
5. **工程落地** ：Nest.js + TypeORM 对接 MySQL，区分开发 / 生产环境配置，完成容器化全流程落地。

> 补充：Docker Compose 多用于 **本地开发、小型部署** ，线上大规模集群后续会过渡到 Kubernetes (K8s)。
