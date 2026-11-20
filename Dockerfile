FROM node:24-bookworm-slim AS web
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM rust:1.95-bookworm AS server
WORKDIR /src/backend
COPY backend/ ./
RUN cargo build --locked --release

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=web /src/frontend/dist /app/web
COPY --from=server /src/backend/target/release/campus-waste-dispatch /usr/local/bin/
ENV WASTE_WEB_ROOT=/app/web WASTE_DB_PATH=/data/campus-waste.sqlite3
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/campus-waste-dispatch"]
