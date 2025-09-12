FROM node:20-slim

WORKDIR /app/worker
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "index.mjs"]
