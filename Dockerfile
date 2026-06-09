# ---- build stage: install deps + build the web app ----
FROM node:24-slim AS build
WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci

# Build the SPA → packages/web/dist
COPY . .
RUN npm run build -w @mm/web

# ---- runtime stage ----
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Bring over installed deps, source, and the built web bundle
COPY --from=build /app /app
EXPOSE 4000
# Server runs via tsx and serves both the API/WebSocket and the built SPA
CMD ["npm", "run", "start", "-w", "@mm/server"]
