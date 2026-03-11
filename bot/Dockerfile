FROM node:22-slim

WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY bot.js ./
COPY config/ ./config/

CMD ["node", "bot.js"]
