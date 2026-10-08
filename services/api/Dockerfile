FROM node:20-alpine

WORKDIR /app

# ไม่ตั้ง NODE_ENV=production ตรงนี้: npm ci จะข้าม devDependencies และ tsx (ใช้รันซอร์ส TS) จะหาย
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production

EXPOSE 4000

CMD ["npx", "--no-install", "tsx", "src/index.ts"]
