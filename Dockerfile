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
RUN cargo build --release

# -- Runtime --
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates tmux && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=backend /app/target/release/omniterm-server ./
COPY --from=frontend /app/dist ./frontend/dist
COPY migrations/ ./migrations/

ENV BIND_ADDR=0.0.0.0:3000
ENV FRONTEND_DIR=frontend/dist
EXPOSE 3000

CMD ["./omniterm-server"]
