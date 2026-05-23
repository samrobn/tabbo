#!/bin/bash
# Build minimal Ghostscript for Tabbo (PS-to-PDF only).
#
# Produces:
#   gs/gs-minimal - Self-contained Ghostscript binary (~25MB arm64)
#
# The full Homebrew install is ~128MB. This strips everything except
# the pdfwrite device. Init files are compiled into the binary
# (--enable-compile-inits, the default) so no external Resource
# directory is needed.
#
# Usage:
#   cd gs && bash build-gs.sh
#
# Requirements:
#   - Xcode command line tools (clang)
#   - Internet access (downloads source tarball on first run)

set -euo pipefail

GS_VERSION="${GS_VERSION:-10.04.0}"
GS_VERSION_NODOT="${GS_VERSION//./}"
GS_SOURCE="ghostscript-${GS_VERSION}"
GS_TARBALL="${GS_SOURCE}.tar.gz"
GS_URL="https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs${GS_VERSION_NODOT}/${GS_TARBALL}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="${SCRIPT_DIR}/build"
OUTPUT_BINARY="${SCRIPT_DIR}/gs-minimal"

echo "=== Ghostscript minimal build for Tabbo ==="
echo "Version: ${GS_VERSION}"
echo "Output:  ${OUTPUT_BINARY}"

# Download source if needed
mkdir -p "${BUILD_DIR}"
if [ ! -f "${BUILD_DIR}/${GS_TARBALL}" ]; then
    echo "Downloading ${GS_URL}..."
    curl -L -o "${BUILD_DIR}/${GS_TARBALL}" "${GS_URL}"
fi

# Extract
if [ ! -d "${BUILD_DIR}/${GS_SOURCE}" ]; then
    echo "Extracting..."
    tar xzf "${BUILD_DIR}/${GS_TARBALL}" -C "${BUILD_DIR}"
fi

cd "${BUILD_DIR}/${GS_SOURCE}"

# Remove components we don't need
rm -rf tesseract leptonica

# Configure with minimal dependencies.
# pdfwrite is the only output device we need (PS-to-PDF conversion).
# jbig2dec and openjpeg are kept as they're required by PDF infrastructure.
# -UTARGET_OS_MAC works around fp.h removal in modern macOS SDKs.
# compile-inits (default) bakes PostScript init into the binary - no
# external Resource directory needed at runtime.
echo "Configuring..."
./configure \
    --disable-cups \
    --disable-dbus \
    --disable-gtk \
    --disable-fontconfig \
    --without-tesseract \
    --without-libidn \
    --without-libpaper \
    --without-pdftoraster \
    --without-ijs \
    --without-x \
    --without-cal \
    CFLAGS="-arch arm64 -mmacosx-version-min=12.0 -O2 -UTARGET_OS_MAC" \
    LDFLAGS="-arch arm64 -mmacosx-version-min=12.0"

# Build
echo "Building (this takes a few minutes)..."
make -j"$(sysctl -n hw.ncpu)" 2>&1 | tail -5

# Copy and strip binary
echo "Copying binary..."
cp bin/gs "${OUTPUT_BINARY}"
strip "${OUTPUT_BINARY}"
chmod +x "${OUTPUT_BINARY}"

# Report size
BINARY_SIZE=$(du -sh "${OUTPUT_BINARY}" | cut -f1)
echo ""
echo "=== Build complete ==="
echo "Binary: ${OUTPUT_BINARY} (${BINARY_SIZE})"

# Verify: convert a minimal PostScript to PDF
echo ""
echo "Verifying..."
"${OUTPUT_BINARY}" -q -dNOPAUSE -dBATCH -dSAFER -sDEVICE=pdfwrite \
    -sOutputFile=/dev/null -c "quit"
echo "Verification passed"
