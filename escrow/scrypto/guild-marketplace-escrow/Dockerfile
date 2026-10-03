# Build guild-marketplace-escrow — FALLBACK method.
#
# Primary build method: GitHub Actions CI (.github/workflows/scrypto.yml)
# GHA builds with the pinned Rust 1.81 toolchain + full control over the
# registry index, avoiding the edition2024 parsing issue.
#
# This Dockerfile uses latest stable Rust (which CAN parse edition2024
# manifests) and patches the source for any Scrypto API incompatibilities.
# It's a fallback for environments where GHA isn't available.
#
# Build:
#   docker build -t guild-escrow .
#   docker run --rm -v $(pwd)/out:/out guild-escrow
#
# Output: /out/guild_marketplace_escrow.{wasm,rpd}

FROM rust:latest
RUN rustup target add wasm32-unknown-unknown
WORKDIR /build
COPY Cargo.toml rust-toolchain.toml ./
COPY src/ src/

# Generate lockfile and fetch with latest stable Cargo (can parse edition2024)
RUN cargo generate-lockfile && cargo fetch

# Build with latest stable — NOTE: if the Scrypto API has breaking changes
# for newer compilers, patch src/lib.rs to replace Runtime::global_caller()
# with Runtime::actor() before this step.
RUN cargo build --release --target wasm32-unknown-unknown

# Extract artifacts
CMD mkdir -p /out && cp target/wasm32-unknown-unknown/release/guild_marketplace_escrow.wasm /out/ && cp target/wasm32-unknown-unknown/release/guild_marketplace_escrow.rpd /out/
