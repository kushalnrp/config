# ── Stage 1: compile to a self-contained binary ──────────────────────────────
FROM oven/bun:1 AS builder

WORKDIR /app
COPY server.js .

# --compile bundles Bun runtime + JS into a single native executable
RUN bun build --compile --outfile config-server server.js

# ── Stage 2: minimal runtime image ───────────────────────────────────────────
FROM debian:12-slim

WORKDIR /app

COPY --from=builder /app/config-server .

RUN mkdir -p data

ENV CONFIG_PORT=2001
ENV CONFIG_DB_PATH=data/config.db

EXPOSE 2001

CMD ["./config-server"]
