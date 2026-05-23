#!/usr/bin/env bash
# build-woff2-fonts.sh — Build WOFF2 fonts for all 14 lute tablature font variants.
#
# Prerequisites (macOS):
#   brew install texlive fontforge
# Prerequisites (Linux / Ubuntu):
#   sudo apt install texlive-metapost texlive-fonts-extra fontforge python3-fontforge
#
# Run from the repository root:
#   bash engine/fonts/build-woff2-fonts.sh
#
# Outputs go to engine/fonts/woff2/. The outputs are committed to the repository
# because TeX Live and FontForge are not available in CI.
#
# Re-running rebuilds all fonts from scratch (temp dirs are cleaned up).
# Byte-for-byte output may vary slightly between runs due to WOFF2/brotli
# compression non-determinism; the glyph content is identical. Commit the
# outputs once; only regenerate when the .mf sources actually change.
#
# PK-to-PUA encoding:
#   The canonical mapping lives in engine/fonts/pua-mapping.json.
#   engine/include/pua_map.h is generated from it (run gen-pua-header.py after edits).
#   assemble-font.py reads the same JSON when setting glyph codepoints.
#
# Notes on mf2pt1 errors:
#   mf2pt1 will emit "Emergency stop" errors and exit non-zero for each font.
#   This is expected and non-fatal: the is_clockwise() implementation in recent
#   MetaPost versions fails on some glyph paths (comma, cadenza wave, etc.), causing
#   mf2pt1 to abort. The individual per-glyph EPS files written before the abort
#   are complete and correct. We continue past the mf2pt1 exit code.
#
#   FontForge's correctDirection() is applied to every glyph during assembly to
#   normalise path winding direction for the ~30 affected glyphs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
FONTS_DIR="${SCRIPT_DIR}"
OUTPUT_DIR="${FONTS_DIR}/woff2"
ASSEMBLE_SCRIPT="${FONTS_DIR}/assemble-font.py"

# Verify prerequisites
for cmd in mf2pt1 fontforge python3; do
    if ! command -v "${cmd}" &>/dev/null; then
        echo "ERROR: '${cmd}' not found. Install prerequisites:" >&2
        echo "  macOS:  brew install texlive fontforge" >&2
        echo "  Ubuntu: sudo apt install texlive-metapost fontforge python3-fontforge" >&2
        exit 1
    fi
done

# Verify FontForge has Python bindings
if ! python3 -c "import fontforge" 2>/dev/null; then
    echo "ERROR: FontForge Python bindings not available." >&2
    echo "  macOS:  brew install fontforge (includes Python bindings)" >&2
    echo "  Ubuntu: sudo apt install python3-fontforge" >&2
    exit 1
fi

mkdir -p "${OUTPUT_DIR}"

# Font variants: <mf_file_basename>:<display_family_name>
# tlute has 4 sizes (6,7,8,9 — no tlute85.mf exists in the tree).
# lute and blute have 5 sizes each (6,7,8,85,9).
declare -a FONTS=(
    "lute6:Tabbo Lute 6pt"
    "lute7:Tabbo Lute 7pt"
    "lute8:Tabbo Lute 8pt"
    "lute85:Tabbo Lute 8.5pt"
    "lute9:Tabbo Lute 9pt"
    "blute6:Tabbo Baroque Lute 6pt"
    "blute7:Tabbo Baroque Lute 7pt"
    "blute8:Tabbo Baroque Lute 8pt"
    "blute85:Tabbo Baroque Lute 8.5pt"
    "blute9:Tabbo Baroque Lute 9pt"
    "tlute6:Tabbo Thin Lute 6pt"
    "tlute7:Tabbo Thin Lute 7pt"
    "tlute8:Tabbo Thin Lute 8pt"
    "tlute9:Tabbo Thin Lute 9pt"
)

total_bytes=0

for entry in "${FONTS[@]}"; do
    font_name="${entry%%:*}"
    family_name="${entry#*:}"
    mf_file="${FONTS_DIR}/${font_name}.mf"
    output_woff2="${OUTPUT_DIR}/${font_name}.woff2"

    if [[ ! -f "${mf_file}" ]]; then
        echo "WARNING: ${mf_file} not found, skipping ${font_name}" >&2
        continue
    fi

    echo "--- ${font_name} ---"

    # Use a per-font temp dir so parallel runs don't collide (currently sequential)
    tmp_dir="$(mktemp -d -t "tabfont_${font_name}_XXXXXX")"
    # shellcheck disable=SC2064
    trap "rm -rf '${tmp_dir}'" EXIT

    # Run mf2pt1 to generate per-glyph EPS files.
    # MFINPUTS must include the fonts dir so that lute9.mf can `input lute.mf`.
    # mf2pt1 exits non-zero on is_clockwise() failure — expected and non-fatal.
    # Redirect stderr->stdout and filter the verbose MetaPost boilerplate.
    # The pipeline exit code is ignored (|| true) because mf2pt1 always fails.
    MFINPUTS="${FONTS_DIR}:" \
        mf2pt1 --output-dir="${tmp_dir}" "${mf_file}" 2>&1 \
        | grep -Ev '^$|MetaPost|Preloading|preliminaries|basic constants|macros for|and a few' \
        || true

    # Assemble WOFF2 from the EPS glyph files
    python3 "${ASSEMBLE_SCRIPT}" \
        "${tmp_dir}" \
        "${font_name}" \
        "${family_name}" \
        "${output_woff2}" \
        2>&1

    if [[ -f "${output_woff2}" ]]; then
        size=$(wc -c < "${output_woff2}")
        total_bytes=$((total_bytes + size))
        echo "  OK: ${font_name}.woff2 (${size} bytes)"
    else
        echo "  FAILED: ${output_woff2} not produced" >&2
        exit 1
    fi

    # Clean up this font's temp dir immediately (trap will also clean on exit)
    rm -rf "${tmp_dir}"
    trap - EXIT
done

echo ""
echo "Done. Total WOFF2 output: ${total_bytes} bytes across ${#FONTS[@]} fonts."
echo "Output directory: ${OUTPUT_DIR}"
