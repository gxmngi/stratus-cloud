FROM node:20-alpine

# git สำหรับ simple-git, docker-cli สำหรับสั่ง Docker Engine ของ Host ผ่าน /var/run/docker.sock
RUN apk add --no-cache git docker-cli

WORKDIR /app

# ไม่ตั้ง NODE_ENV=production ตรงนี้: npm ci จะข้าม devDependencies และ tsx (ใช้รันซอร์ส TS) จะหาย
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN mkdir -p /workspace

ENV NODE_ENV=production \
    WORKSPACE_DIR=/workspace

CMD ["npx", "--no-install", "tsx", "src/index.ts"]
