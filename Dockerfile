FROM node:20-slim
RUN apt-get update && apt-get install -y chromium dumb-init
ENV CHROMIUM_PATH=/usr/bin/chromium
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["dumb-init", "npm", "start"]
