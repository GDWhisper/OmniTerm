# -- Build frontend --
FROM node:22-alpine AS frontend
WORKDIR /app
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN corepack enable && pnpm install --no-frozen-lockfile
COPY frontend/ ./
RUN pnpm build

# -- Build backend --
FROM rust:1.87-bookworm AS backend
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src/ src/
COPY migrations/ migrations/
COPY --from=frontend /app/dist ./frontend/dist
RUN cargo build --release

# -- Runtime --
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates tmux && rm -rf /var/lib/apt/lists/*

# 分支专属变量（build 时由 --build-arg 传入；详见 AGENTS.md "配置统一管理"）
# - BRANCH_BINARY_NAME: 二进制文件名（如 omniterm）
# - DOCKER_PORT: 容器内监听端口（与 host 端口映射 host:container）
# 都有合理默认值（main worktree 默认值）
ARG BRANCH_BINARY_NAME=omniterm
ARG DOCKER_PORT=9077

WORKDIR /app
COPY --from=backend /app/target/release/${BRANCH_BINARY_NAME} ./
COPY --from=frontend /app/dist ./frontend/dist

ENV BIND_ADDR=0.0.0.0:${DOCKER_PORT}
ENV FRONTEND_DIR=frontend/dist
EXPOSE ${DOCKER_PORT}

CMD ["./${BRANCH_BINARY_NAME}"]
