FROM node:22-alpine

WORKDIR /service
COPY container/ ./
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
