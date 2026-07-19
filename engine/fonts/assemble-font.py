#!/usr/bin/env python3
"""
Assemble a single WOFF2 font from mf2pt1-generated EPS glyph files.

Called by build-woff2-fonts.sh with:
  python3 assemble-font.py <eps_dir> <font_name> <family_name> <output_woff2>

Reads pua-mapping.json from the same directory as this script to determine
the PK-to-PUA encoding. Each EPS file is named <font_name>.<pk_code> (no
extension -- mf2pt1's output format).

mf2pt1 metadata in each EPS provides the glyph advance width (charwd field)
and the font's design size in typographic points (font_size field).

Coordinate system and scaling
------------------------------
mf2pt1 runs at mag=100, so 1 typographic point = 100 EPS big-point units.
A glyph designed for a 9pt font occupies roughly 900 EPS units of cap height.
FontForge imports EPS in raw units; we target unitsPerEm=1000 for a standard
scalable font, so every imported glyph is scaled by:

    scale = 1000 / (font_size * 100)

With this scale, CSS font-size: Xpt on a font with design size Xpt renders
glyphs at their intended physical size. The relationship between lute6/7/8/85/9
is preserved: each family renders proportionally smaller or larger than the
others when the same CSS font-size is applied.

Some glyphs (flags, ornaments) extend well above the 1000-unit em square;
ascent=800, descent=200 is a standard split. The webview positions glyphs
absolutely and does not rely on CSS line-height, so these metadata values are
cosmetically irrelevant.
"""

import fontforge
import json
import os
import psMat
import re
import shutil
import sys
import tempfile


def parse_mf2pt1_charwd(eps_path: str) -> float:
    """
    Return the charwd (advance width in typographic points) from the MF2PT1
    metadata comment in the EPS file. Returns 0.0 if not found.
    """
    try:
        with open(eps_path) as f:
            for line in f:
                m = re.match(r'% MF2PT1: charwd ([\d.]+)', line)
                if m:
                    return float(m.group(1))
                if line.startswith(' 0 0 0 setrgbcolor') or line.startswith('showpage'):
                    break
    except OSError:
        pass
    return 0.0


def parse_mf2pt1_font_size(eps_path: str) -> float:
    """
    Return the font_size (in typographic points) from the MF2PT1 metadata
    comment in the EPS file. Returns 0.0 if not found.
    """
    try:
        with open(eps_path) as f:
            for line in f:
                m = re.match(r'% MF2PT1: font_size ([\d.]+)', line)
                if m:
                    return float(m.group(1))
                if line.startswith(' 0 0 0 setrgbcolor') or line.startswith('showpage'):
                    break
    except OSError:
        pass
    return 0.0


def detect_font_size(eps_dir: str, font_name: str, pk_to_unicode: dict[int, int]) -> float:
    """
    Return the mf2pt1 font_size for this font by reading the first available
    EPS glyph file. Falls back to 9.0 if no file yields metadata.
    """
    for pk_code in sorted(pk_to_unicode.keys()):
        eps_src = os.path.join(eps_dir, f"{font_name}.{pk_code}")
        if os.path.exists(eps_src):
            size = parse_mf2pt1_font_size(eps_src)
            if size > 0:
                return size
    return 9.0


# mf2pt1 traces METAFONT pen strokes into a single self-intersecting outline
# per glyph (the pen's stroke envelope, not a separate outer+counter contour
# pair). Browsers/Skia render an SVG <text> glyph fine in isolation under the
# nonzero fill rule, but when that self-intersecting contour overlaps other
# opaque content (e.g. a staff-line rule drawn behind or in front of it in the
# live preview), the overlap interacts badly with the renderer's coverage
# computation and produces large white knockouts inside the glyph's ink
# (task 20260718-E65Q). removeOverlap() decomposes the self-intersecting
# contour into proper simple (non-self-intersecting) contours, which the PDF
# export path never needed because it paints PK glyphs as opaque bitmaps.
#
# removeOverlap()'s boolean union leaves sub-pixel sliver contours at the
# former self-intersection points (near-tangent numerical noise, not real
# geometry -- verified by area: real contours measure in the hundreds of
# thousands of square units at 1000 UPM, slivers measure under 5). Drop them
# or they render as stray hairline artefacts.
SLIVER_AREA_THRESHOLD = 5.0


def _contour_area(contour) -> float:
    """Shoelace-formula area of a FontForge contour, in font units²."""
    points = [(p.x, p.y) for p in contour]
    area = 0.0
    for i in range(len(points)):
        x1, y1 = points[i]
        x2, y2 = points[(i + 1) % len(points)]
        area += x1 * y2 - x2 * y1
    return abs(area) / 2.0


def clean_glyph_overlap(g: "fontforge.glyph") -> None:
    """
    Remove self-intersections from a glyph's outline in place, dropping the
    numerical-noise slivers removeOverlap() leaves behind. Must run before
    correctDirection() re-normalises the resulting simple contours' winding.
    """
    had_contours = len(g.foreground) > 0
    g.removeOverlap()
    layer = g.foreground
    sliver_indices = [i for i, c in enumerate(layer) if _contour_area(c) < SLIVER_AREA_THRESHOLD]
    for i in reversed(sliver_indices):
        del layer[i]

    if had_contours and len(layer) == 0:
        raise RuntimeError(f"clean_glyph_overlap emptied glyph {g.glyphname!r} in font {g.font.fontname!r}")

    g.foreground = layer


def load_mapping(mapping_path: str) -> dict[int, int]:
    """
    Return {pk_code: unicode_codepoint} from pua-mapping.json.
    ASCII zone: pk == unicode. PUA zone: unicode = offset + pk.
    """
    with open(mapping_path) as f:
        mapping = json.load(f)

    result: dict[int, int] = {}
    for pk in mapping["ascii_zone"]["codes"]:
        result[pk] = pk
    offset = mapping["pua_zone"]["offset"]
    for pk in mapping["pua_zone"]["codes"]:
        result[pk] = offset + pk
    return result


def main() -> None:
    if len(sys.argv) != 5:
        print(f"Usage: {sys.argv[0]} <eps_dir> <font_name> <family_name> <output_woff2>", file=sys.stderr)
        sys.exit(1)

    eps_dir, font_name, family_name, output_woff2 = sys.argv[1:]

    script_dir = os.path.dirname(os.path.abspath(__file__))
    mapping_path = os.path.join(script_dir, "pua-mapping.json")
    pk_to_unicode = load_mapping(mapping_path)

    # Detect design size from EPS metadata so we can derive the correct scale.
    # mf2pt1 embeds font_size in every per-glyph EPS file.
    font_size = detect_font_size(eps_dir, font_name, pk_to_unicode)

    # Scale factor: map mf2pt1 EPS coordinate space (1pt = 100 units) to a
    # standard 1000-UPM font. At this scale, CSS font-size: Xpt applied to a
    # font with design size Xpt renders glyphs at their intended physical size.
    #
    # Example (lute9, font_size=9):
    #   scale = 1000 / (9 * 100) = 1.1111
    #   charwd 5.6pt -> EPS 560 units -> scaled 622 units -> at 9pt = 5.6pt rendered
    #
    # Glyphs with stems/flags extend beyond the 1000-unit em (some reach ~5500
    # units); ascent=800 and descent=200 are a standard split. Stems that
    # exceed ascent are not clipped -- CSS font metrics only affect line layout,
    # not individual glyph rendering when positioned absolutely.
    scale = 1000.0 / (font_size * 100.0)

    print(f"  {font_name}: font_size={font_size}pt, scale={scale:.6f}", file=sys.stderr)

    f = fontforge.font()
    f.fontname = re.sub(r'[^A-Za-z0-9]', '_', font_name)
    f.familyname = family_name
    f.fullname = family_name
    f.version = "1.0"
    f.copyright = "Derived from lute/blute/tlute METAFONT sources by Wayne Cripps"

    # 1000 UPM is the conventional unit size for scalable fonts. Ascent=800,
    # descent=200 is a standard split; most text glyphs fit within 0..800.
    # Ornamental glyphs that exceed this range are not clipped in the browser.
    f.em = 1000
    f.ascent = 800
    f.descent = 200

    scale_mat = psMat.scale(scale)

    # Use a single shared temp dir for all EPS copies (FontForge needs .eps extension)
    tmp_dir = tempfile.mkdtemp(prefix="tabfont_")
    imported = 0
    skipped_missing = 0
    skipped_error = 0

    try:
        for pk_code, unicode_cp in sorted(pk_to_unicode.items()):
            eps_src = os.path.join(eps_dir, f"{font_name}.{pk_code}")
            if not os.path.exists(eps_src):
                skipped_missing += 1
                continue

            glyph_name = f"uni{unicode_cp:04X}"
            g = f.createChar(unicode_cp, glyph_name)

            # FontForge requires a .eps extension to recognise the format
            eps_tmp = os.path.join(tmp_dir, f"{pk_code}.eps")
            shutil.copy(eps_src, eps_tmp)

            try:
                g.importOutlines(eps_tmp)
            except Exception as e:
                print(f"  Warning: import failed for PK {pk_code}: {e}", file=sys.stderr)
                f.removeGlyph(unicode_cp)
                skipped_error += 1
                continue

            # Scale imported outlines from EPS coordinate space to 1000 UPM.
            # Must be done before correctDirection so winding-direction checks
            # operate on the final coordinates.
            g.transform(scale_mat)

            # Decompose mf2pt1's self-intersecting pen-stroke contour into
            # simple contours before normalising winding direction (see
            # clean_glyph_overlap docstring -- task 20260718-E65Q).
            clean_glyph_overlap(g)

            # Normalise path winding universally. mf2pt1 logs ~30 is_clockwise()
            # failures; correctDirection() handles those and any silently-wrong paths.
            g.correctDirection()

            # Set advance width from mf2pt1 metadata, scaled to 1000 UPM.
            # charwd is in typographic points; EPS units = charwd * 100;
            # scaled units = charwd * 100 * scale = charwd * 1000 / font_size.
            charwd = parse_mf2pt1_charwd(eps_src)
            if charwd > 0:
                g.width = int(round(charwd * 1000.0 / font_size))
            else:
                bb = g.boundingBox()
                g.width = max(0, int(round(bb[2])))

            imported += 1

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    print(
        f"  {font_name}: {imported} glyphs imported, "
        f"{skipped_missing} missing from this variant, "
        f"{skipped_error} import errors",
        file=sys.stderr,
    )

    if imported == 0:
        print(f"ERROR: no glyphs imported for {font_name}", file=sys.stderr)
        sys.exit(1)

    os.makedirs(os.path.dirname(output_woff2) or ".", exist_ok=True)
    f.generate(output_woff2)
    size = os.path.getsize(output_woff2)
    print(f"  -> {output_woff2} ({size:,} bytes)", file=sys.stderr)


if __name__ == "__main__":
    main()
