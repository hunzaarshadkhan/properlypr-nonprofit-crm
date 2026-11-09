FROM node:24.21.0-bookworm-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install --global pnpm@10.32.1 && pnpm install --prod --frozen-lockfile --ignore-scripts
COPY build.mjs index.html worker.js workflow.js cadence.js csv.js csv-api.js ./
COPY drizzle ./drizzle
COPY dev/database.mjs ./dev/database.mjs
COPY server ./server
COPY scripts ./scripts
RUN node build.mjs
ENV NODE_ENV=production PORT=8080 CRM_DATABASE_PATH=/data/crm.sqlite
EXPOSE 8080
CMD ["node", "server/server.mjs"]
