# Multi-stage Dockerfile for OSS Analyser (PERN Stack)
# Stage 1: Build TypeScript
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
COPY public/ ./public/

RUN npm run build

# Stage 2: Production Runtime
FROM node:22-alpine AS runner

WORKDIR /app

# Install git, python3, pip, and uv (Astral fast Python tool)
RUN apk add --no-cache git python3 py3-pip uv

# Install graphify with 20+ native Tree-Sitter language parsers
RUN uv tool install graphifyy
ENV PATH="/root/.local/bin:${PATH}"

ENV NODE_ENV=production
ENV PORT=4000

COPY package*.json ./
RUN npm ci --omit=dev

# Copy built assets, migrations, and schema files
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY drizzle/ ./drizzle/
RUN echo "Checking migration files" && ls -la /app/drizzle && ls -la /app/drizzle/meta
COPY src/modules/storage/schema.sql ./dist/modules/storage/schema.sql
COPY src/modules/storage/schema.sql ./src/modules/storage/schema.sql

EXPOSE 4000

CMD ["node", "dist/index.js"]
