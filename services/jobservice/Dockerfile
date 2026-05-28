FROM node:20-alpine AS base
RUN npm install -g pnpm@9
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY services/jobservice/package.json ./services/jobservice/

RUN pnpm install --frozen-lockfile

FROM base AS build
COPY packages/shared/ ./packages/shared/
COPY services/jobservice/ ./services/jobservice/

RUN pnpm build:shared && pnpm --filter jobservice build

RUN CI=true pnpm prune --prod

FROM node:20-alpine AS runner
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/shared/dist ./packages/shared/dist/
COPY --from=build /app/services/jobservice/package.json ./services/jobservice/
COPY --from=build /app/services/jobservice/dist ./services/jobservice/dist/

ARG PORT=7002
ENV PORT=${PORT}
EXPOSE ${PORT}

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget -q http://localhost:${PORT}/health -O /dev/null || exit 1

USER node
CMD node services/jobservice/dist/index.js
