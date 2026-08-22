# opencode-go-watch on homelab — runs the Cloudflare Worker under workerd (miniflare)
# Same worker code, zero changes. KV persists to ./data volume.
# NOTE: Debian slim (NOT alpine) — workerd is a glibc binary.
FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates wget && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --ignore-scripts --no-audit --no-fund
COPY . .
ENV WRANGLER_SEND_METRICS=false CI=true NPM_CONFIG_UPDATE_NOTIFIER=false
EXPOSE 8787
# .dev.vars is generated at start from env (secrets never baked into image)
CMD ["sh", "-c", "printf 'TELEGRAM_BOT_TOKEN=%s\nADMIN_TOKEN=%s\n' \"$TELEGRAM_BOT_TOKEN\" \"$ADMIN_TOKEN\" > .dev.vars && npx wrangler dev --ip 0.0.0.0 --port 8787"]
