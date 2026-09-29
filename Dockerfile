FROM node:24-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl git ca-certificates ripgrep && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod
RUN npm install -g @openai/codex@0.158.0-alpha.2.1
ARG CLOUDFLARED_VERSION=2026.9.3
RUN arch="$(dpkg --print-architecture)" \
  && case "$arch" in \
       amd64) cloudflared_arch="amd64" ;; \
       arm64) cloudflared_arch="arm64" ;; \
       armhf) cloudflared_arch="arm" ;; \
       *) echo "Unsupported cloudflared architecture: $arch" >&2; exit 1 ;; \
     esac \
  && curl -fsSL "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${cloudflared_arch}" -o /usr/local/bin/cloudflared \
  && chmod +x /usr/local/bin/cloudflared \
  && cloudflared --version
COPY src ./src
COPY public ./public
COPY config ./config
EXPOSE 3000
CMD ["node", "src/web.js"]
