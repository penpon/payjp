FROM node:22-alpine

WORKDIR /app

# Install dependencies (layer-cached before source copy)
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/shared/package.json packages/shared/
COPY packages/auth-service/package.json packages/auth-service/
COPY packages/billing-service/package.json packages/billing-service/
COPY packages/sync-service/package.json packages/sync-service/

RUN npm ci

# Copy source
COPY packages/ packages/

EXPOSE 3000

CMD ["node_modules/.bin/tsx", "packages/server/src/main.ts"]
