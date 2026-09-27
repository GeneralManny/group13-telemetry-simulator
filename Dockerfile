# syntax=docker/dockerfile:1

# 1. Next.js dashboard -> static export in /dash/out
FROM node:22-alpine AS dashboard
WORKDIR /dash
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci
COPY dashboard ./
RUN npm run build

# 2. Simulator API -> dist/
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# 3. Runtime: one process serves the API and the dashboard
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=dashboard /dash/out ./dashboard/out
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
