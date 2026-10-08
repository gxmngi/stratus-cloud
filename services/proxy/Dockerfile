# syntax=docker/dockerfile:1
FROM golang:1.24-alpine AS build
ENV GOTOOLCHAIN=local

WORKDIR /src

COPY go.mod ./
COPY *.go ./

RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/stratus-proxy .

FROM alpine:3.20

RUN adduser -D -H -u 10001 stratus

COPY --from=build /out/stratus-proxy /usr/local/bin/stratus-proxy

ENV PORT=8000 \
    WORKSPACE_DIR=/workspace

USER stratus

EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/stratus-proxy"]
