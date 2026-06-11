# ============================================
# 阶段一：builder（构建阶段）
# 需要完整依赖才能编译代码，编译完就丢弃
# ============================================
FROM node:24.15-alpine AS builder

WORKDIR /app

COPY package*.json ./

RUN npm config set registry https://registry.npmmirror.com/
RUN npm install

COPY . .

# 编译项目：TS → JS
RUN npm run build

# ============================================
# 阶段二：production（运行阶段）
# 只保留生产依赖 + 编译产物，这就是最终镜像
# ============================================
FROM node:24.15-alpine

# 设置环境变量为生产模式
ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./

RUN npm config set registry https://registry.npmmirror.com/
# --production 表示只安装 dependencies，不装 devDependencies
RUN npm install --production

# 从 builder 阶段复制编译产物（关键语法！）
COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/main.js"]