# Tex's computer: a Linux box with the everyday tools a job needs, and no internet
# (the Durable Object starts it with enableInternet: false, src/index.ts). Everything
# a job can use is baked in here, since nothing can be installed at run time.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-pandas python3-openpyxl python3-matplotlib python3-numpy python3-bs4 python3-lxml \
      sqlite3 poppler-utils jq git zip unzip ca-certificates bc file less \
 && rm -rf /var/lib/apt/lists/*

# One unprivileged user owns the work folder; the server and every command run as it.
RUN useradd --create-home --home-dir /work --shell /bin/bash tex
WORKDIR /service
COPY container/ ./
USER tex
ENV TEX_WORK=/work
EXPOSE 8080
CMD ["node", "server.mjs"]
