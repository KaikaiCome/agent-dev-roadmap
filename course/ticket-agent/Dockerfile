FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production DATABASE_PATH=/data/agent.db PORT=8787
# 运行时没有第三方依赖（typescript 只用于开发时类型检查），只需要复制源码
COPY package.json tsconfig.json ./
COPY src ./src
# 不用 root 运行；数据库放在挂载卷里，容器重建不丢数据
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/main.ts"]
