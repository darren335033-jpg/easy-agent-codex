ARG BASE_IMAGE=python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258
FROM ${BASE_IMAGE}
# Supply BASE_IMAGE=<verified image@sha256:...> for reproducible builds.
# No source, credentials, package installs, or generated code enter the image.
USER 65534:65534
WORKDIR /tmp
