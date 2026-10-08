FROM node:20-alpine

# git สำหรับ simple-git, docker-cli สำหรับสั่ง Docker Engine ของ Host ผ่าน /var/run/docker.sock
RUN apk add --no-cache git docker-cli

WORKDIR /app

ENV NODE_ENV=production \
    WORKSPACE_DIR=/workspace

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN mkdir -p /workspace

CMD ["./node_modules/.bin/tsx", "src/index.ts"]
