FROM node:22-slim

WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY bot.js pii.js auth.js graph.js email-intents.js gmail-auth.js gmail-api.js ./

CMD ["node", "bot.js"]
