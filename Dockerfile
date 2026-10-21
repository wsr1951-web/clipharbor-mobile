FROM denoland/deno:bin-2.9.6 AS deno
FROM brainicism/bgutil-ytdlp-pot-provider:2.0.2 AS pot
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates \
    && python3 -m venv /opt/tools \
    && /opt/tools/bin/pip install --no-cache-dir 'yt-dlp[default]==2026.10.10.233141.dev0' \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deno /deno /usr/local/bin/deno
COPY --from=pot /app /opt/bgutil
RUN /opt/tools/bin/pip install --no-cache-dir 'bgutil-ytdlp-pot-provider==2.0.2'
WORKDIR /app
COPY package.json server.cjs LICENSE ./
COPY engine ./engine
COPY public ./public
RUN mkdir -p /app/vendor /data \
    && ln -s /opt/tools/bin/yt-dlp /app/vendor/yt-dlp.exe \
    && ln -s /usr/bin/ffmpeg /app/vendor/ffmpeg.exe \
    && ln -s /usr/bin/ffmpeg /app/vendor/ffmpeg \
    && ln -s /usr/bin/ffprobe /app/vendor/ffprobe.exe \
    && ln -s /usr/bin/ffprobe /app/vendor/ffprobe \
    && ln -s /usr/local/bin/deno /app/vendor/deno.exe \
    && chown -R node:node /data
ENV NODE_ENV=production PORT=10000 DATA_DIR=/data VENDOR_DIR=/app/vendor YOUTUBE_POT_HOME=/opt/bgutil
USER node
EXPOSE 10000
CMD ["node", "server.cjs"]
