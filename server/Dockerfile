FROM rust:1-slim-bookworm AS build

WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY data ./data
COPY src ./src
RUN cargo build --release --bin server

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/target/release/server /usr/local/bin/server

ENV PORT=3000
EXPOSE 3000

CMD ["/usr/local/bin/server"]
