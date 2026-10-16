# Build TypeScript in a dependency-complete stage.
FROM node:22-alpine AS build
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY app ./app
COPY scripts ./scripts
COPY src ./src
COPY migrations ./migrations
RUN npm run build

# Runtime image contains production dependencies and compiled code only.
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=node:node /srv/dist ./dist
COPY --from=build --chown=node:node /srv/migrations ./migrations
COPY --from=build --chown=node:node /srv/scripts/verify-suite.sh /srv/scripts/verify-suite.sh
USER node
EXPOSE 8000
CMD ["node", "dist/app/main.js"]
