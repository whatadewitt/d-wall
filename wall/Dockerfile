# wall-server: the Fastify server plus the built client it serves.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY tsconfig.base.json eslint.config.js ./
COPY server server
COPY client client
RUN npm run lint && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist
USER node
WORKDIR /app/server
EXPOSE 9600
CMD ["node", "dist/index.js"]
