# =========================================================================
# Stage 1: Build & Compile TypeScript
# =========================================================================
FROM node:20-alpine AS builder

WORKDIR /app

# Install system dependencies needed for native modules
RUN apk add --no-cache libc6-compat openssl

COPY package*.json ./
COPY tsconfig.json ./
COPY prisma ./prisma/

RUN npm ci

COPY src ./src/

RUN npx prisma generate
RUN npm run build

# =========================================================================
# Stage 2: Production Runtime
# =========================================================================
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000

RUN apk add --no-cache openssl curl

# Create unprivileged service user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 watchdog

COPY package*.json ./
COPY prisma ./prisma/

# Install production dependencies only
RUN npm ci --omit=dev && npm cache clean --force
RUN npx prisma generate

# Copy compiled JavaScript output from builder stage
COPY --from=builder /app/dist ./dist/

# Set ownership to unprivileged user
RUN chown -R watchdog:nodejs /app

USER watchdog

EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:4000/livez || exit 1

CMD ["node", "dist/index.js"]
