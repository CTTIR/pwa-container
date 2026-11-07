# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    SURVEYS_DIR=/surveys \
    THEMES_DIR=/themes \
    ADMIN_CREDENTIALS_FILE=/config/admins.json \
    TZ=Europe/Berlin
RUN apk add --no-cache tzdata \
 && mkdir -p /data /surveys /themes /config \
 && chown node:node /data
WORKDIR /app
# The server only uses Node built-ins; the built web app is static files.
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
COPY package.json ./
USER node
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server/main.ts"]
