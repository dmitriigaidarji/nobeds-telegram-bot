FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY tsconfig.json ./

# Only the registered iCal links live here; mount a volume so a restart
# doesn't lose them. Booking data goes to /tmp and is meant to be disposable.
ENV DB_PATH=/app/data/feeds.db
ENV SNAPSHOT_PATH=/tmp/nobeds-snapshot.db
VOLUME ["/app/data"]

CMD ["bun", "run", "src/index.ts"]
