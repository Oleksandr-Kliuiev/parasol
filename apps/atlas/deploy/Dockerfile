# Atlas deployment image (docs/deploy/DEPLOY.md): the API with the operator console, the scheduler and the one-shot admin tools.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund
COPY . .
RUN npx prisma generate --schema prisma && npm run api:build && chown -R node:node /app/dist
USER node
ENV NODE_ENV=production
EXPOSE 3100
CMD ["node", "dist/apps/api/src/main.js"]
