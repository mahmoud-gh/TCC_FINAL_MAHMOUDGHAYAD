FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY . .
RUN if [ -f scripts/copy-drawflow-assets.js ]; then node scripts/copy-drawflow-assets.js; fi
EXPOSE 3000
CMD ["sh", "-c", "node src/db/migrate.js && node server.js"]