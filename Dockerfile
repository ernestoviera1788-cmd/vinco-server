# ---- builder: instala TODO (incl. devDeps) y compila TypeScript ----
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# ---- runtime: solo dependencias de producción + dist compilado ----
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY --from=builder /app/dist ./dist
COPY migrations ./migrations
COPY web ./web
ENV NODE_ENV=production
EXPOSE 8080
CMD ["sh", "-c", "node dist/migrate.js && node dist/index.js"]
