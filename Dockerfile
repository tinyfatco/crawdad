FROM node:22-bookworm

# Install git
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Clone troublemaker, install deps, build, link globally
ARG TROUBLEMAKER_VERSION=1
RUN git clone --depth 1 https://github.com/tinyfatco/troublemaker.git /opt/troublemaker && \
    cd /opt/troublemaker && \
    npm install --ignore-scripts && \
    npm run build && \
    npm link

# Install Chromium system deps + Puppeteer's bundled Chrome
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libxshmfence1 libxfixes3 \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
RUN npx puppeteer browsers install chrome && \
    ln -s /root/.cache/puppeteer/chrome/*/chrome-linux64/chrome /usr/bin/chromium

# Pre-install browser-tools npm deps so agents don't need to npm install at runtime
# NODE_PATH makes these available to any script regardless of working directory
RUN npm install -g puppeteer-core@23 puppeteer-extra puppeteer-extra-plugin-stealth
ENV NODE_PATH=/usr/local/lib/node_modules

# Install GitHub CLI (gh) so agents can interact with GitHub
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y gh tmux && \
    rm -rf /var/lib/apt/lists/*

# Clone fat-skills (platform skills) and install deps
# Scripts go on PATH so agents can call them by name
ARG FAT_SKILLS_VERSION=1
RUN git clone --depth 1 https://github.com/tinyfatco/fat-skills.git /opt/fat-skills && \
    cd /opt/fat-skills/browser-tools && \
    npm install && \
    for f in browser-*.js; do ln -sf /opt/fat-skills/browser-tools/$f /usr/local/bin/$f; done

# Data directory — bind-mount from host (rclone FUSE → R2)
VOLUME /data

# Gateway port (single port for all adapters)
EXPOSE 3002

ENTRYPOINT ["crawdad"]
CMD ["--sandbox=host", "--port=3002", "/data"]
