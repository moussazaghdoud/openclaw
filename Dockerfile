FROM ghcr.io/openclaw/openclaw:latest

USER node
RUN mkdir -p /home/node/.openclaw
COPY openclaw.json /home/node/.openclaw/openclaw.json

CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured", "--bind", "lan"]
