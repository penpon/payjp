FROM node:22-alpine

WORKDIR /app

# Install dependencies (layer-cached before source copy)
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/server/package.json packages/server/
COPY packages/shared/package.json packages/shared/
COPY packages/auth-service/package.json packages/auth-service/
COPY packages/billing-service/package.json packages/billing-service/
COPY packages/sync-service/package.json packages/sync-service/
COPY frontend/package.json frontend/

RUN npm ci

# Copy source
COPY packages/ packages/

# Run as non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000

CMD ["node_modules/.bin/tsx", "packages/server/src/main.ts"]
