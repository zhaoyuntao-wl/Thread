FROM node:20-alpine
WORKDIR /app

# 只复制本包与内核产物（部署前先在仓库根跑 pnpm --filter @thread/aml-adapter build）
COPY package.json ./
COPY dist ./dist
COPY node_modules/@thread-memory/core ./node_modules/@thread-memory/core

ENV PORT=8787
EXPOSE 8787

CMD ["node", "dist/server.js"]
