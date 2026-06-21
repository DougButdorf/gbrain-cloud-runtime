FROM oven/bun:1.3.13-slim

ARG GBRAIN_REPO=https://github.com/garrytan/gbrain.git
ARG GBRAIN_GIT_REF=9bf96db807c2f050449142f2f0b05726f58e5054

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git procps \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV GBRAIN_HOME=/data/gbrain-home
ENV PORT=8765

RUN mkdir -p /data/gbrain-home /data/tmp

COPY patches /tmp/gbrain-patches

RUN git clone "${GBRAIN_REPO}" /opt/gbrain-src \
  && cd /opt/gbrain-src \
  && git checkout "${GBRAIN_GIT_REF}" \
  && if [ -f /tmp/gbrain-patches/gbrain-local-model-routing.patch ]; then git apply /tmp/gbrain-patches/gbrain-local-model-routing.patch; fi \
  && bun install --production \
  && rm -rf /tmp/gbrain-patches

WORKDIR /app
COPY entrypoint.sh /app/entrypoint.sh
COPY collector-granola-propagation.sh /app/collector-granola-propagation.sh
COPY collectors /app/collectors
RUN chmod +x /app/entrypoint.sh /app/collector-granola-propagation.sh /app/collectors/gbrain-granola-propagation.js

EXPOSE 8765

CMD ["/app/entrypoint.sh"]
