FROM node:22-alpine

WORKDIR /service
COPY container/ ./
RUN npm ci --omit=dev
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
