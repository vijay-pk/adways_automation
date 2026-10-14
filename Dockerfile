# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci
COPY server server
COPY web web
RUN (cd server && npx prisma generate) \
 && npm run build --workspace server \
 && npm run build --workspace web

# ---- runtime ----
FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/prisma server/prisma
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
WORKDIR /app/server
ENV SERVE_WEB_DIST=/app/web/dist UPLOAD_DIR=/data/uploads WHATSAPP_WEB_SESSION_DIR=/data/wa-session PORT=3000
RUN mkdir -p /data/uploads /data/wa-session && chmod 700 /data/wa-session && chown -R node:node /data
USER node
EXPOSE 3000
# Apply pending migrations, then start API + worker.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
