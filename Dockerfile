# Node 22: payjp@3 requires >=22; matches .github/workflows/ci.yml.
FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_OPTIONS="--max-old-space-size=8192"

# Install dependencies (layer-cached before source copy)
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/server/package.json packages/server/
COPY packages/shared/package.json packages/shared/
COPY packages/auth-service/package.json packages/auth-service/
COPY packages/billing-service/package.json packages/billing-service/
COPY packages/sync-service/package.json packages/sync-service/
COPY frontend/package.json frontend/
COPY packages/admin-server/package.json packages/admin-server/
COPY admin-frontend/package.json admin-frontend/

RUN npm ci

# Copy source
COPY packages/ packages/

# Run as non-root user
RUN groupadd --system appgroup && useradd --system --gid appgroup --no-create-home appuser
USER appuser

EXPOSE 3000

CMD ["node_modules/.bin/tsx", "packages/server/src/main.ts"]
