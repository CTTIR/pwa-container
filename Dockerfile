# Base image pinned by digest (node:24-alpine, Node 24.22); update deliberately.
FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    SURVEYS_DIR=/surveys \
    THEMES_DIR=/themes \
    ADMIN_CREDENTIALS_FILE=/config/admins.json \
    TZ=Europe/Berlin
# A dedicated user id that no host account or other container on the server uses.
RUN apk add --no-cache tzdata \
 && addgroup -S -g 10001 pwa && adduser -S -D -H -u 10001 -G pwa pwa \
 && mkdir -p /data /surveys /themes /config /routes \
 && chown pwa:pwa /data /routes
WORKDIR /app
# The server only uses Node built-ins; the built web app is static files.
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
COPY package.json ./
USER 10001:10001
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server/main.ts"]
