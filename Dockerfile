FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./server.js
COPY src ./src

EXPOSE 3000
CMD ["node", "server.js"]
