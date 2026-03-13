FROM node:22-slim

WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY bot.js pii.js ./

CMD ["node", "bot.js"]
