# syntax=docker/dockerfile:1
FROM golang:1.24-alpine AS build
ENV GOTOOLCHAIN=local

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY *.go ./

RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/stratus-proxy .

FROM alpine:3.20

# ca-certificates จำเป็นสำหรับ Let's Encrypt (ACME) ในเฟสถัดไป
RUN apk add --no-cache ca-certificates \
    && adduser -D -H -u 10001 stratus

COPY --from=build /out/stratus-proxy /usr/local/bin/stratus-proxy

ENV PORT=8000 \
    WORKSPACE_DIR=/workspace \
    CERT_CACHE_DIR=/certs

RUN mkdir -p /certs && chown stratus:stratus /certs
VOLUME ["/certs"]

USER stratus

# 80: ACME HTTP-01 + redirect, 443: HTTPS (เปิดเมื่อตั้ง TLS_DOMAINS)
EXPOSE 80 443 8000

ENTRYPOINT ["/usr/local/bin/stratus-proxy"]
