# Delphi Agent Arena Bot — one cron tick per container start.
#
# The agent runs a single pass and exits, so this image is a task, not a
# service. Scheduling belongs to whatever runs it (Render Cron, k8s CronJob,
# systemd timer) rather than to a process supervisor inside the container.

FROM node:22-slim AS build
WORKDIR /app

# better-sqlite3 compiles a native addon, so the build stage needs a toolchain.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY scripts ./scripts

# Fail the build rather than ship a broken agent.
RUN npx tsc --noEmit

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Structured logs by default: a cron's output is read by machines first.
ENV LOG_FORMAT=json

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts

# SQLite lives here. Mount a volume, or every tick starts amnesiac and the
# drawdown breaker, daily trade cap and trade idempotency all stop working.
RUN mkdir -p /data && chown -R node:node /data /app
ENV DATABASE_PATH=/data/state.db
VOLUME ["/data"]

USER node

# Default is the safe one. Override with `--live-ai` to trade for real.
CMD ["npx", "tsx", "src/app.ts", "--dry-run", "--live-ai"]
