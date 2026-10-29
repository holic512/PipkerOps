FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0
RUN addgroup -S pipkerops && adduser -S -G pipkerops pipkerops
COPY --from=build --chown=pipkerops:pipkerops /app/node_modules ./node_modules
COPY --from=build --chown=pipkerops:pipkerops /app/.next/standalone ./
COPY --from=build --chown=pipkerops:pipkerops /app/.next/static ./.next/static
COPY --from=build --chown=pipkerops:pipkerops /app/src ./src
COPY --from=build --chown=pipkerops:pipkerops /app/prisma ./prisma
COPY --from=build --chown=pipkerops:pipkerops /app/scripts ./scripts
COPY --from=build --chown=pipkerops:pipkerops /app/package.json /app/tsconfig.json /app/prisma.config.ts ./
RUN mkdir -p /app/.data/pki && chown -R pipkerops:pipkerops /app/.data
USER pipkerops
EXPOSE 3000 9443 9444
CMD ["node","server.js"]
