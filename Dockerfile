FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY addon.js ./
COPY src ./src
ENV PORT=7000
EXPOSE 7000
CMD ["node", "addon.js"]
