FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY apps/atlas/package*.json ./
COPY apps/atlas/prisma/ ./prisma/
RUN npm ci
COPY apps/atlas/ ./
RUN npx prisma generate && npm run api:build
COPY deploy/hostinger/atlas-host.mjs ./parasol-host.mjs
FROM build AS admin
USER node
ENTRYPOINT ["node", "parasol-host.mjs"]
CMD ["serve"]

FROM build AS production-dependencies
RUN npm prune --omit=dev

FROM base AS server
COPY --from=production-dependencies /app/node_modules/ ./node_modules/
COPY --from=build /app/dist/ ./dist/
COPY --from=build /app/package.json /app/parasol-host.mjs ./
USER node
ENTRYPOINT ["node", "parasol-host.mjs"]
CMD ["serve"]
