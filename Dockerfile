# ── Stage 1: compile Go binary ────────────────────────────────────────────────
FROM golang:1.25-alpine AS builder

WORKDIR /app

# Download dependencies first (cached layer)
COPY go.mod go.sum ./
RUN go mod download

# Build the server
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o config-server .

# ── Stage 2: minimal runtime image ───────────────────────────────────────────
FROM alpine:latest

WORKDIR /app

COPY --from=builder /app/config-server .

RUN mkdir -p data

ENV CONFIG_PORT=2001
ENV CONFIG_DB_PATH=data/config.db
EXPOSE 2001

CMD ["./config-server"]
