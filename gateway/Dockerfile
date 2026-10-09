FROM node:22-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 compiles from source when no prebuilt binary matches the platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
# deploy/lib.sh removes the gateway images an upgrade leaves without a tag by this label.
LABEL poise.image=gateway
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chmod 700 /data
# Root inside the container: the gateway drives the Docker Engine through the mounted
# socket, which is root-equivalent on the host whatever user the process runs as.
EXPOSE 8080
CMD ["node", "dist/main.js"]
