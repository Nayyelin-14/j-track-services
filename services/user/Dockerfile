FROM node:20-alpine AS base
RUN npm install -g pnpm@9
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY services/user/package.json ./services/user/

RUN pnpm install --frozen-lockfile

FROM base AS build
COPY packages/shared/ ./packages/shared/
COPY services/user/ ./services/user/

RUN pnpm build:shared && pnpm --filter user build

RUN CI=true pnpm prune --prod

FROM node:20-alpine AS runner
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/shared/dist ./packages/shared/dist/
COPY --from=build /app/services/user/package.json ./services/user/
COPY --from=build /app/services/user/dist ./services/user/dist/

ARG PORT=7001
ENV PORT=${PORT}
EXPOSE ${PORT}

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget -q http://localhost:${PORT}/health -O /dev/null || exit 1

USER node
CMD ["node", "services/user/dist/index.js"]
