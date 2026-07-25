FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .
RUN mkdir -p /app/storage/public/agreements \
  /app/storage/public/professionals \
  /app/storage/public/services \
  /app/storage/private \
  && chown -R node:node /app/storage

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1

USER node

CMD ["node", "server.mjs"]
