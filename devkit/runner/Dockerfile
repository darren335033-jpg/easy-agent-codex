# Build in a trusted environment. Runtime execution never pulls images.
# Override BASE_IMAGE with a verified digest for reproducible builds.
ARG BASE_IMAGE=node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
FROM ${BASE_IMAGE}
# Generated source enters only an ephemeral /workspace tmpfs through stdin.
# This image intentionally contains no workspace, credentials, or project deps.
# npm:test and npm:build run offline. Projects needing packages require a
# separately built trusted image containing those dependencies; no installation
# or registry access occurs during snapshot execution.
USER 65534:65534
WORKDIR /workspace
