# Свой сервер: тот же server/index.js в режиме HTTP. Зависимостей нет.
FROM node:22-alpine

ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    PORT=8000

WORKDIR /app
COPY package.json ./
COPY server ./server

# не root внутри контейнера
USER node

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
