FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

EXPOSE 4000

# tsx ถูกติดตั้งเป็น devDependency จึงใช้ runtime เดียวกับ README (ไม่ต้อง build ก่อน)
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
