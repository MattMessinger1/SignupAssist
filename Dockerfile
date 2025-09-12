FROM node:20-slim

WORKDIR /app

# Install dependencies
COPY worker/package*.json ./
RUN npm ci --omit=dev

# Copy worker source
COPY worker/ .

ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "index.mjs"]