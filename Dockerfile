# -- Build frontend --
FROM node:22-alpine AS frontend
WORKDIR /app
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
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

WORKDIR /app
COPY --from=backend /app/target/release/omniterm-main ./
COPY --from=frontend /app/dist ./frontend/dist

ENV BIND_ADDR=0.0.0.0:9077
ENV FRONTEND_DIR=frontend/dist
EXPOSE 9077

CMD ["./omniterm-main"]
