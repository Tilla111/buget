FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY playwright.config.js ./
COPY tests ./tests

CMD ["npx", "playwright", "test", "--project=chromium"]
