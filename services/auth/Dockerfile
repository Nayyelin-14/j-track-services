FROM node:20-alpine AS base
RUN npm install -g pnpm@9
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY services/auth/package.json ./services/auth/

RUN pnpm install --frozen-lockfile

FROM base AS build
COPY packages/shared/ ./packages/shared/
COPY services/auth/ ./services/auth/

RUN pnpm build:shared && pnpm --filter auth build

RUN CI=true pnpm prune --prod

FROM node:20-alpine AS runner
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/shared/dist ./packages/shared/dist/
COPY --from=build /app/services/auth/package.json ./services/auth/
COPY --from=build /app/services/auth/dist ./services/auth/dist/

ARG PORT=7000
ENV PORT=${PORT}
EXPOSE ${PORT}

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget -q http://localhost:${PORT}/health -O /dev/null || exit 1

USER node
CMD node services/auth/dist/index.js
