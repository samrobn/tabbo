# Multi-stage build for sandboxed tab binary execution
# Security: Isolated execution environment for web compilations

# Stage 1: Build the binary
FROM debian:bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    g++ \
    make \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy source files
COPY include/ include/
COPY src/ src/
COPY Makefile .

# Build with optimisations and font path set for container
RUN make clean 2>/dev/null || true && \
    make OPTIM="-O2" TLOC='"\"/app/fonts\""'

# Stage 2: Minimal runtime image
FROM debian:bookworm-slim

# Create non-root user for execution
RUN groupadd -r tabuser && useradd -r -g tabuser tabuser

# Create working directories
RUN mkdir -p /app/fonts /work && \
    chown -R tabuser:tabuser /work

# Copy binary from builder stage
COPY --from=builder /build/tab /app/tab

# Copy fonts from host
COPY fonts/ /app/fonts/

# Make binary executable (owned by root, executable by all)
RUN chmod 755 /app/tab

# Set font path environment variable
ENV TABFONTS=/app/fonts

# Switch to non-root user
USER tabuser

# Working directory for input/output
WORKDIR /work

# Default entrypoint runs tab binary with security flags
# Usage: docker run -v /host/temp:/work tabbo-compiler input.tab -o output.ps
ENTRYPOINT ["/app/tab", "-no-includes"]
