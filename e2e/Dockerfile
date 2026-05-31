FROM node:22-alpine AS base
RUN npm install -g pnpm@latest
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY e2e/package.json e2e/
RUN pnpm install --frozen-lockfile

COPY e2e/ e2e/
CMD ["pnpm", "--filter", "e2e", "test"]
