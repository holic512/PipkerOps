FROM node:24-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0
RUN apk add --no-cache postgresql17-client && addgroup -S -g 10001 pipkerops && adduser -S -u 10001 -G pipkerops pipkerops
COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/.next/standalone ./
COPY --from=build --chown=10001:10001 /app/.next/static ./.next/static
COPY --from=build --chown=10001:10001 /app/src ./src
COPY --from=build --chown=10001:10001 /app/prisma ./prisma
COPY --from=build --chown=10001:10001 /app/scripts ./scripts
COPY --from=build --chown=10001:10001 /app/deploy/resources/runtime.ts /app/deploy/resources/health.ts /app/deploy/resources/entrypoint.sh ./deploy/resources/
COPY --from=build --chown=10001:10001 /app/package.json /app/tsconfig.json /app/prisma.config.ts ./
RUN mkdir -p /app/.data/credentials /app/.data/releases /app/.data/backups && chown -R 10001:10001 /app/.data
USER 10001:10001
EXPOSE 3000 9444
ENTRYPOINT ["sh", "/app/deploy/resources/entrypoint.sh"]
CMD ["web"]
