FROM node:24-alpine AS production

WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY newrelic.js ./
COPY src ./src

USER node
EXPOSE 4100

CMD ["node", "src/index.js"]
