FROM node:24-alpine AS build

ARG BUILD_VERSION=container
ENV COMMIT_SHA=$BUILD_VERSION
ENV JELLYFIN_VERSION=$BUILD_VERSION

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build:production

FROM nginxinc/nginx-unprivileged:1.29-alpine

LABEL org.opencontainers.image.title="Jellyfin Web with playback diagnostics"
LABEL org.opencontainers.image.description="Jellyfin Web fork with improved HLS recovery, buffering, and client playback diagnostics"
LABEL org.opencontainers.image.licenses="GPL-2.0-or-later"

USER root
# hadolint ignore=DL3018
RUN apk add --no-cache jq

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/20-configure-jellyfin.sh /docker-entrypoint.d/20-configure-jellyfin.sh
COPY --from=build --chown=101:101 /app/dist/ /usr/share/nginx/html/
RUN chmod 755 /docker-entrypoint.d/20-configure-jellyfin.sh

USER 101

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget --quiet --spider http://127.0.0.1:8080/healthz || exit 1
