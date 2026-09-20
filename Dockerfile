# -- Build frontend --
FROM node:22-alpine AS frontend
WORKDIR /app
# 与仓库一致的 workspace 结构（根 manifest + frontend/ 子包）：根 pnpm-lock.yaml 的
# importer 路径才能对上，即使 --no-frozen-lockfile 也按锁版本解析、不漂移。
# Cargo.toml 是前端版本号唯一真相源（vite.config.ts 读上一级，无回退），必须随拷。
# 宿主 node_modules/frontend/dist 由 .dockerignore 排除，容器内安装是 alpine 原生的。
COPY Cargo.toml pnpm-workspace.yaml pnpm-lock.yaml ./
COPY frontend/package.json ./frontend/
RUN corepack enable && pnpm install --no-frozen-lockfile
COPY frontend/ ./frontend/
RUN cd frontend && pnpm build

# -- Build backend --
FROM rust:1.87-bookworm AS backend
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src/ src/
COPY migrations/ migrations/
COPY --from=frontend /app/frontend/dist ./frontend/dist
RUN cargo build --release

# -- Runtime --
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates tmux && rm -rf /var/lib/apt/lists/*

# 分支专属变量（build 时由 --build-arg 传入；详见 AGENTS.md "配置统一管理"）
# - DOCKER_PORT: 容器内监听端口（与 host 端口映射 host:container）
# 有合理默认值（main worktree 默认值）
# 二进制名固定为 omniterm（Cargo.toml name 全分支统一，不再按分支区分）
ARG DOCKER_PORT=9077

WORKDIR /app
COPY --from=backend /app/target/release/omniterm ./
COPY --from=frontend /app/frontend/dist ./frontend/dist

ENV OMNITERM_HOST=0.0.0.0
ENV OMNITERM_PORT=${DOCKER_PORT}
ENV FRONTEND_DIR=frontend/dist
EXPOSE ${DOCKER_PORT}

CMD ./omniterm start
