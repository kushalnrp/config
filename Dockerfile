# ── Stage 1: compile to a self-contained binary ──────────────────────────────
FROM oven/bun:1-alpine AS builder

WORKDIR /app
COPY server.js .

# --compile bundles Bun runtime + JS into a single native executable
RUN bun build --compile --outfile config-server server.js

# ── Stage 2: minimal runtime image ───────────────────────────────────────────
FROM alpine:latest

WORKDIR /app

# Install glibc compatibility for the compiled binary (much smaller than gcc)
RUN apk add --no-cache libc6-compat

COPY --from=builder /app/config-server .

RUN mkdir -p data

ENV CONFIG_PORT=2001
ENV CONFIG_DB_PATH=data/config.db

EXPOSE 2001

CMD ["./config-server"]
