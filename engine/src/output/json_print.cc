/*
 * json_print.cc — layout JSON output backend.
 *
 * Subclass of print.  Accumulates draw operations in memory as a
 * LayoutResult (pages → systems → primitives) and serialises to JSON on
 * destruction.  PostScript backend is completely unaffected.
 *
 * Design decisions captured in PLAN-live-preview-refactor.md §Phase 1.
 * Coordinate origin: top-left.  dvi_v in the base class decreases as we
 * move down; we convert to y = page_top_dvi - dvi_v throughout.
 */

#include "win.h"
#include "tab.h"
#include "json_print.h"
#include "pua_map.h"

#include <stdio.h>
#include <string.h>
#include <stdarg.h>

/* ---- External refs shared with format_page/tfm_stuff ---- */
extern double red;
extern int baroque;
extern int thin_renaissance;
extern double staff_len;  /* sizes.cc — content width in inches */

/* ---- forward declared in tab.h / dvi.h ---- */
int inch_to_dvi(double inch);
int inch_to_dvi_unscaled(double inch);
int str_to_dvi(const char *string);

/* ---- format_page forward declaration ---- */
int format_page(print *p, i_buf *i_b, font_list *f_a[], struct file_info *f);

/* ================================================================
 * Constructor / destructor
 * ================================================================ */

json_print::json_print(font_list *font_array[], file_info *f)
{
    int i;
    f_a = font_array;
    f_i = f;
    npages = 0;
    current_page_num  = 0;
    current_system_num = 0;
    page_open = false;

    run_open = false;
    run_font = -1;
    run_x = run_y = 0;
    run_last_advance = 0;

    worker_mode    = (f->m_flags & WORKER_MODE) != 0;
    abandon_output = false;

    for (i = 0; i < 8; i++) font_seen[i] = false;

    /* Page canvas: US Letter in the engine's DVI coordinate scale.
     * Must use inch_to_dvi_unscaled so the canvas stays physical-paper size
     * even when -R reduces red (font scaling must not shrink the page). */
    page_top_dvi   = inch_to_dvi_unscaled(11.0);          /* US Letter height */
    page_width_dvi = inch_to_dvi_unscaled(8.5);           /* US Letter width */
    left_margin_dvi = inch_to_dvi((double)f->left_margin / 72.0);
    top_margin_dvi  = inch_to_dvi((double)f->top_margin  / 72.0);
    staff_len_dvi   = inch_to_dvi(staff_len);

    out_fname[0] = '\0';
    if (f->out_file && f->out_file[0]) {
        strncpy(out_fname, f->out_file, BUFSIZ - 1);
        out_fname[BUFSIZ - 1] = '\0';

        /* Trim trailing spaces (set_o appends a space after extension) */
        size_t len = strlen(out_fname);
        while (len > 0 && out_fname[len - 1] == ' ') {
            out_fname[--len] = '\0';
        }

        /* set_o appends .ps, .dvi, or .mid before we can intercept the
         * JSON_OUT flag (flag ordering on the command line is arbitrary).
         * Strip any known auto-added extension, then add .json.
         * Do this in a loop so "foo.json.dvi" → "foo.json" → "foo" → "foo.json". */
        for (;;) {
            char *dot = strrchr(out_fname, '.');
            if (!dot) break;
            if (strcmp(dot, ".ps")   == 0 ||
                strcmp(dot, ".dvi")  == 0 ||
                strcmp(dot, ".mid")  == 0 ||
                strcmp(dot, ".json") == 0) {
                *dot = '\0';
            } else {
                break;
            }
        }
        strncat(out_fname, ".json", BUFSIZ - strlen(out_fname) - 1);
    }

    /* Initialise dvi position at top of page (mirrors ps_print::init_hv) */
    dvi_h = 0;
    dvi_v = page_top_dvi;
}

json_print::~json_print()
{
    if (abandon_output) return;

    flush_run();
    if (worker_mode) {
        /* Worker mode: emit a single NDJSON line to stdout.  Errors have
         * already been collected in g_error_sink by dbg(Error,...); the
         * normal (non-error) destructor path is called when tfm_stuff
         * completes successfully, so g_error_sink reflects any warnings
         * accumulated during the run. */
        write_json_worker(g_error_sink);
    } else {
        const char *fname = out_fname[0] ? out_fname : "out.json";
        write_json(fname);
    }
}

/* ================================================================
 * Font manifest tracking
 * ================================================================ */

void json_print::record_font(int font_id)
{
    if (font_id < 0 || font_id >= 8) return;
    if (font_seen[font_id]) return;
    font_seen[font_id] = true;

    JsonFontDesc fd;
    fd.font_id = font_id;

    if (font_id == 0) {
        /* Derive tab font family name from globals, same logic as tfm_stuff() */
        char lutefont[80];
        strcpy(lutefont, "");
        if (f_i->font_names[0]) {
            strncat(lutefont, f_i->font_names[0], sizeof(lutefont) - 1);
        } else {
            if (baroque)
                strcat(lutefont, "blute");
            else if (thin_renaissance)
                strcat(lutefont, "tlute");
            else
                strcat(lutefont, "lute");
        }
        if (red == 1.0)          strcat(lutefont, "9");
        else if (red == 0.9444)  strcat(lutefont, "85");
        else if (red == 0.8888)  strcat(lutefont, "8");
        else if (red == 0.77777) strcat(lutefont, "7");
        else                     strcat(lutefont, "6");

        fd.family   = lutefont;
        fd.type     = "tab";
        fd.has_size = false;
    } else {
        /* Text font: use font_list name and size */
        if (f_a && f_a[font_id] && f_a[font_id]->name) {
            /* Use real_name when available (PostScript font name),
             * otherwise the short TFM name */
            if (f_a[font_id]->real_name && f_a[font_id]->real_name[0])
                fd.family = f_a[font_id]->real_name;
            else
                fd.family = f_a[font_id]->name;
        } else {
            char tmp[32];
            snprintf(tmp, sizeof(tmp), "font%d", font_id);
            fd.family = tmp;
        }
        fd.type     = "text";
        fd.has_size = true;
        fd.size_pt  = f_i->font_sizes[font_id];
    }

    font_manifest.push_back(fd);
}

/* ================================================================
 * text_run aggregation helpers
 * ================================================================ */

/*
 * flush_run: close the current text_run and add it to the current system.
 * No-op if no run is open.
 */
void json_print::flush_run()
{
    if (!run_open) return;
    run_open = false;

    if (run_text.empty()) return;

    ensure_system_open();

    JsonPrimitive p;
    p.type       = JPRIM_TEXT_RUN;
    p.run_font_id = run_font;
    p.run_x      = run_x;
    p.run_y      = dvi_v_to_y(run_y);
    p.run_text   = run_text;
    emit_primitive(p);
}

/*
 * json_utf8_codepoint: append a Unicode codepoint encoded as UTF-8 to out.
 */
void json_print::json_utf8_codepoint(std::string &out, int cp)
{
    if (cp < 0) return;  /* unmapped — skip */
    if (cp < 0x80) {
        out += (char)cp;
    } else if (cp < 0x800) {
        out += (char)(0xC0 | (cp >> 6));
        out += (char)(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
        out += (char)(0xE0 | (cp >> 12));
        out += (char)(0x80 | ((cp >> 6) & 0x3F));
        out += (char)(0x80 | (cp & 0x3F));
    } else {
        out += (char)(0xF0 | (cp >> 18));
        out += (char)(0x80 | ((cp >> 12) & 0x3F));
        out += (char)(0x80 | ((cp >> 6) & 0x3F));
        out += (char)(0x80 | (cp & 0x3F));
    }
}

/* ================================================================
 * Page / system management
 * ================================================================ */

void json_print::ensure_system_open()
{
    if (!page_open) {
        JsonPage pg;
        pg.page_num = current_page_num;
        pages.push_back(pg);
        page_open = true;
        /* Start system 0 */
        JsonSystem sys;
        sys.system_num = 0;
        pages.back().systems.push_back(sys);
        current_system_num = 0;
    }
}

JsonPage &json_print::current_page()
{
    ensure_system_open();
    return pages.back();
}

JsonSystem &json_print::current_system()
{
    ensure_system_open();
    return current_page().systems.back();
}

void json_print::emit_primitive(const JsonPrimitive &p)
{
    current_system().primitives.push_back(p);
}

/* ================================================================
 * do_page — called by the pass2/format_page loop.
 * Each call is one page.  We open a new page context, run format_page,
 * then close and advance.
 * ================================================================ */

int json_print::do_page(i_buf *i_b, font_list *f_l[])
{
    flush_run();

    npages++;
    current_page_num = npages;
    page_open = false;
    current_system_num = 0;

    /* Reset DVI position to top of page (mirrors ps_print::init_hv) */
    dvi_h = 0;
    dvi_v = page_top_dvi;

    return format_page(this, i_b, f_l, f_i);
}

/*
 * new_system_if_needed — called from push() to detect system boundaries.
 *
 * MVP implementation: we don't attempt to split primitives across systems
 * within a page. All primitives for a page go into a single system (system 0).
 * System boundaries are present in the schema for forward compatibility
 * but not yet populated across systems.
 *
 * System detection via push/pop depth is unreliable because pass2, score.cc,
 * and dvi_f.cc all push/pop at different nesting levels for different purposes
 * (staff lines, individual notes, chord groups). printsystem() in draw.cc now
 * calls begin_system() once per system (see below), but that hook only feeds
 * the additive top-level "anchors" array -- it does not gate primitive
 * placement, so primitives still all land in system 0. Actually splitting
 * primitives per system remains a separate task.
 */
void json_print::new_system_if_needed(int /*old_sp*/)
{
    /* No-op for MVP. All primitives go into system 0 on each page. */
}

/*
 * begin_system — called once per system from printsystem() (draw.cc), right
 * after n_system++.  Records an anchor mapping the system's source line to
 * its typeset position, for the frontend's editor-scroll-sync feature.
 * dvi_v at this point is the top of the system (movev calls already applied
 * by the caller before printsystem runs) -- same coordinate space primitives
 * use, converted the same way via dvi_v_to_y.
 */
void json_print::begin_system(int source_line)
{
    if (source_line <= 0) return;  /* unknown -- skip (see get_system_source_line) */

    JsonAnchor a;
    a.line = source_line;
    a.page = current_page_num;
    a.y    = dvi_v_to_y(dvi_v);
    anchors.push_back(a);
}

/* ================================================================
 * Cursor movement
 * ================================================================ */

void json_print::p_moveh(const int hor)
{
    if (hor == 0) return;
    /* Check if this is a regular text advance that continues the run.
     * We flush on irregular moves; regular advances are handled inside
     * set_a_char by the run_last_advance check.  Any explicit p_moveh
     * call that isn't from set_a_char is treated as a flush trigger. */
    flush_run();
    dvi_h += hor;
}

void json_print::p_movev(const int ver)
{
    if (ver == 0) return;
    flush_run();
    dvi_v -= ver;
}

void json_print::p_moveto(const int hor, const int ver)
{
    flush_run();
    dvi_h = hor;
    dvi_v = ver;
}

/* ================================================================
 * Characters
 * ================================================================ */

/*
 * put_a_char — tab font (font 0) individual glyphs.
 * Translates PK code → PUA codepoint, emits a glyph primitive.
 * Also advances the cursor by the TFM width.
 */
void json_print::put_a_char(unsigned char c)
{
    flush_run();  /* put_a_char is always an isolated glyph */

    record_font(curfont);
    ensure_system_open();

    int char_code;
    if (curfont == 0) {
        char_code = pk_to_pua((int)(unsigned char)c);
        if (char_code < 0) {
            /* Unmapped PK code — this is a bug in the mapping table */
            fprintf(stderr, "json_print: WARNING: pk_to_pua(%d) returned -1 "
                    "(unmapped PK code); emitting raw pk code\n", (int)(unsigned char)c);
            char_code = (int)(unsigned char)c;
        }
    } else {
        char_code = (int)(unsigned char)c;
    }

    JsonPrimitive p;
    p.type           = JPRIM_GLYPH;
    p.glyph_font_id  = curfont;
    p.glyph_char_code = char_code;
    p.glyph_x        = dvi_h;
    p.glyph_y        = dvi_v_to_y(dvi_v);
    emit_primitive(p);

    /* Matches PS gsave/show/grestore semantics — caller is responsible for
     * cursor positioning across composed glyphs.  Do not advance dvi_h here;
     * set_a_char is the advancing variant used for normal text runs. */
}

/*
 * set_a_char — text fonts (fonts 1-7) with text_run aggregation.
 *
 * Aggregation rules (from design brief):
 *   - Flush on: font change, p_moveto, p_movev, any p_moveh that is
 *     not equal to run_last_advance.
 *   - Anchor x/y from dvi_h/dvi_v at the moment of the first char.
 *   - Append resolved codepoint as UTF-8.
 *   - Word-tie character (font 0 char 0201 mid-text) is handled as
 *     put_a_char since it's in font 0; won't appear here.
 *
 * This function mirrors the width advance logic from ps_print::set_a_char.
 */
void json_print::set_a_char(unsigned char c)
{
    record_font(curfont);
    ensure_system_open();

    /* Compute TFM advance width in DVI units BEFORE appending char.
     * Match ps_print::set_a_char width computation exactly.
     * The special-case remappings only apply to text fonts (curfont != 0)
     * because ps_print remaps those codes before calling the PS font metrics. */
    int advance_dvi = 0;
    if (f_a && f_a[curfont] && f_a[curfont]->fnt) {
        if (curfont == 0) {
            /* Lute font: use the raw character width directly */
            advance_dvi = inch_to_dvi(f_a[curfont]->fnt->get_width(c));
        } else if (c == 0365) {
            advance_dvi = inch_to_dvi(f_a[curfont]->fnt->get_width('i'));
        } else if (c == 0074) {
            advance_dvi = inch_to_dvi(f_a[curfont]->fnt->get_width('!'));
        } else if (c == 0076) {
            advance_dvi = inch_to_dvi(f_a[curfont]->fnt->get_width('?'));
        } else if (c == 014) {  /* fi */
            advance_dvi = inch_to_dvi(f_a[curfont]->fnt->get_width(0256));
        } else if (c == 015) {  /* fl */
            advance_dvi = inch_to_dvi(f_a[curfont]->fnt->get_width(0257));
        } else if (c == 031) {  /* german ss */
            advance_dvi = inch_to_dvi(f_a[curfont]->fnt->get_width(031));
        } else {
            advance_dvi = inch_to_dvi(f_a[curfont]->fnt->get_width(c));
        }
    }

    /* Determine whether to flush the current run.
     *
     * Flush when: font changed, or current cursor position doesn't match
     * where the last character advance left us (run_last_advance tracks the
     * expected dvi_h after each character is added to the run). */
    bool flush_needed = false;
    if (run_open) {
        if (run_font != curfont)
            flush_needed = true;
        else
            flush_needed = (dvi_h != run_last_advance);
    }

    if (!run_open || flush_needed) {
        if (run_open) flush_run();
        /* Start new run */
        run_open   = true;
        run_font   = curfont;
        run_x      = dvi_h;
        run_y      = dvi_v;
        run_text.clear();
        run_last_advance = dvi_h;  /* expected position = current position */
    }

    /* Resolve character to Unicode codepoint / UTF-8.
     *
     * For font 0 (lute/tab font): use the raw character code as-is.
     * set_a_char on font 0 is used for baroque numbers and ornament flags;
     * the ligature remapping in ps_print::set_a_char only applies to curfont!=0.
     * We append the raw byte (or UTF-8 encoded codepoint for >127).
     *
     * For text fonts (curfont != 0): remap PS ligature codes to multi-char
     * sequences and handle Latin-1 special characters per the design brief.
     */
    if (curfont == 0) {
        /* Lute font: translate PK code to PUA codepoint via mapping table.
         * Mirror the warn-and-fallback contract of put_a_char so both paths
         * behave consistently on unmapped codes. */
        int cp = pk_to_pua((int)c);
        if (cp < 0) {
            fprintf(stderr, "json_print: WARNING: pk_to_pua(%d) returned -1 "
                    "(unmapped PK code); emitting raw pk code\n", (int)(unsigned char)c);
            cp = (int)(unsigned char)c;
        }
        json_utf8_codepoint(run_text, cp);
    } else if (c == 0013) {
        /* ff ligature: two f chars */
        run_text += 'f';
        run_text += 'f';
    } else if (c == 0014 || c == 0256) {
        /* fi ligature — internal code 0014 (DVI path) and Adobe
         * StandardEncoding slot 0256 (title.cc/special() pre-convert to
         * this when the PS flag is set, which the JSON path also carries). */
        run_text += 'f';
        run_text += 'i';
    } else if (c == 0015 || c == 0257) {
        /* fl ligature — internal 0015 and StandardEncoding slot 0257. */
        run_text += 'f';
        run_text += 'l';
    } else if (c == 0246) {
        /* long s (\sl) — StandardEncoding slot 0246; emit U+017F ſ. */
        json_utf8_codepoint(run_text, 0x017F);
    } else if (c == 0031) {
        /* German ß (ss) — U+00DF */
        json_utf8_codepoint(run_text, 0x00DF);
    } else if (c == 0032) {
        /* ae — U+00E6 */
        json_utf8_codepoint(run_text, 0x00E6);
    } else if (c == 0033) {
        /* oe — U+0153 */
        json_utf8_codepoint(run_text, 0x0153);
    } else if (c == 0034) {
        /* oo — no standard Unicode; use two o's */
        run_text += 'o';
        run_text += 'o';
    } else if (c == 0035) {
        /* AE — U+00C6 */
        json_utf8_codepoint(run_text, 0x00C6);
    } else if (c == 0036) {
        /* OE — U+0152 */
        json_utf8_codepoint(run_text, 0x0152);
    } else if (c == 0037) {
        /* OO — two O's */
        run_text += 'O';
        run_text += 'O';
    } else if (c == 0074) {
        /* inverted ! — U+00A1 */
        json_utf8_codepoint(run_text, 0x00A1);
    } else if (c == 0076) {
        /* inverted ? — U+00BF */
        json_utf8_codepoint(run_text, 0x00BF);
    } else if (c == 0365) {
        /* special space-like char, treat as space */
        run_text += ' ';
    } else if ((unsigned char)c < 0x80) {
        run_text += (char)c;
    } else {
        /* High bytes: treat as Latin-1 and encode as UTF-8 */
        json_utf8_codepoint(run_text, (unsigned char)c);
    }

    /* Advance cursor (mirrors ps_print::set_a_char) */
    dvi_h += advance_dvi;
    /* Update expected next position */
    run_last_advance = dvi_h;
}

/* ================================================================
 * Font selection
 * ================================================================ */

void json_print::use_font(int fontnum)
{
    if (fontnum != curfont) {
        flush_run();
    }
    curfont = fontnum;
    record_font(fontnum);
}

/* ================================================================
 * Push / pop — cursor save/restore (same as ps_print)
 * ================================================================ */

/*
 * glp — override the base-class cursor-restore to avoid double-corruption.
 *
 * print::glp() does a direct assign (dvi_h = h[reg]; dvi_v = v[reg]) then
 * immediately undoes it via "dvi_v -= v_diff; p_movev(v_diff)".  That
 * pattern exists so the DVI backend can emit relative-move DVI commands.
 * json_print doesn't emit DVI commands and its p_movev/p_moveh directly
 * mutate dvi_v/dvi_h, so the round-trip produces a double-offset:
 *
 *   After glp: dvi_v = old_v - 2*(saved_v - old_v)   [WRONG]
 *
 * Fix: restore the saved values directly.  After dozens of push/pop cycles
 * in a real document this avoids the exponential drift that caused y-values
 * to reach ±1 billion DVI units (page_height_dvi is ~98 million).
 */
void json_print::glp(int reg, int h[], int v[])
{
    if (reg >= REGS)
        dbg1(Error, "tab: getloc: illegal register %d\n", (void *)reg);
    flush_run();
    dvi_h = h[reg];
    dvi_v = v[reg];
}

void json_print::push()
{
    int old_sp = sp;
    flush_run();
    slp(sp, stack_h, stack_v);
    sp++;
    new_system_if_needed(old_sp);
}

void json_print::pop()
{
    flush_run();
    sp--;
    glp(sp, stack_h, stack_v);
    /* Note: glp calls p_moveh/p_movev which will flush_run again, but
     * run_open is already false so those are no-ops. */
}

/* ================================================================
 * Rules
 * ================================================================ */

void json_print::p_put_rule(int w, int h)
{
    flush_run();
    ensure_system_open();

    JsonPrimitive p;
    p.type        = JPRIM_RULE;
    p.rule_x      = dvi_h;
    p.rule_y      = dvi_v_to_y(dvi_v) - h;   // top of rule (SVG rect semantics); PS baseline is bottom
    p.rule_width  = w;
    p.rule_height = h;
    emit_primitive(p);
}

/* ================================================================
 * Ties
 * ================================================================ */

void json_print::do_tie(double length)
{
    flush_run();
    ensure_system_open();

    JsonPrimitive p;
    p.type        = JPRIM_TIE;
    p.tie_x       = dvi_h;
    p.tie_y       = dvi_v_to_y(dvi_v);
    p.tie_length  = inch_to_dvi(length);
    p.tie_variant = TIE_NORMAL;
    emit_primitive(p);
}

void json_print::do_tie_reversed(double length)
{
    flush_run();
    ensure_system_open();

    JsonPrimitive p;
    p.type        = JPRIM_TIE;
    p.tie_x       = dvi_h;
    p.tie_y       = dvi_v_to_y(dvi_v);
    p.tie_length  = inch_to_dvi(length);
    p.tie_variant = TIE_REVERSED;
    emit_primitive(p);
}

void json_print::do_half_tie(double length)
{
    flush_run();
    ensure_system_open();

    JsonPrimitive p;
    p.type        = JPRIM_TIE;
    p.tie_x       = dvi_h;
    p.tie_y       = dvi_v_to_y(dvi_v);
    p.tie_length  = inch_to_dvi(length);
    p.tie_variant = TIE_HALF;
    emit_primitive(p);
}

void json_print::do_half_tie_reversed(double length)
{
    flush_run();
    ensure_system_open();

    JsonPrimitive p;
    p.type        = JPRIM_TIE;
    p.tie_x       = dvi_h;
    p.tie_y       = dvi_v_to_y(dvi_v);
    p.tie_length  = inch_to_dvi(length);
    p.tie_variant = TIE_HALF_REVERSED;
    emit_primitive(p);
}

void json_print::do_rtie(int bloc, int eloc)
{
    flush_run();
    ensure_system_open();

    JsonPrimitive p;
    p.type        = JPRIM_RTIE;
    /* Anchor on the live cursor, not save_h/save_v[bloc].
     * The sole caller (dvi_f.cc triplet ornament) does saveloc(bloc) then
     * movev(...) BEFORE calling do_rtie, so save_v[bloc] != dvi_v at the call.
     * ps_print's do_rtie emits PTIE (doslur) at the live PS cursor; we must
     * mirror that or the triplet tie lands off by the movev. Same bug pattern
     * as put_slash. Span still spans the saved registers. */
    p.tie_x       = dvi_h;
    p.tie_y       = dvi_v_to_y(dvi_v);
    p.tie_length  = save_h[eloc] - save_h[bloc];
    p.tie_variant = TIE_NORMAL;
    emit_primitive(p);
}

/* ================================================================
 * Slash / beam marks
 * ================================================================ */

void json_print::put_slash(int bloc, int eloc, int count, struct file_info * /*f*/)
{
    flush_run();
    ensure_system_open();

    JsonPrimitive p;
    p.type        = JPRIM_SLASH;
    /* Anchor on the live cursor, not save_h/save_v[bloc].
     * dvi_f.cc applies grid_indent (+0.033 in right) and move_n_v("0.19 in")
     * (up) AFTER saveloc(bloc) but BEFORE calling put_slash. ps_print's
     * put_slash uses p_put_rule, which draws from the live cursor; we must
     * mirror that or bars land below-and-left of the flag-stave verticals. */
    p.slash_x     = dvi_h;
    p.slash_y     = dvi_v_to_y(dvi_v);
    p.slash_width = save_h[eloc] - save_h[bloc];
    p.slash_count = count;
    emit_primitive(p);
}

/* ================================================================
 * Underlines
 * ================================================================ */

void json_print::put_uline(int bloc, int eloc)
{
    flush_run();
    ensure_system_open();

    JsonPrimitive p;
    p.type           = JPRIM_ULINE;
    /* x/y asymmetry is deliberate: callers in uline.cc do getloc(bloc) right
     * before put_uline, so dvi_h == save_h[bloc] at this point. NOT the same
     * bug pattern as put_slash above. */
    p.uline_x        = save_h[bloc];
    p.uline_y        = dvi_v_to_y(dvi_v);
    p.uline_width    = save_h[eloc] - save_h[bloc];
    p.uline_variant  = ULINE_NORMAL;
    emit_primitive(p);
}

void json_print::put_r_uline(int bloc, int eloc)
{
    flush_run();
    ensure_system_open();

    JsonPrimitive p;
    p.type           = JPRIM_ULINE;
    p.uline_x        = save_h[bloc];
    p.uline_y        = dvi_v_to_y(dvi_v);
    p.uline_width    = save_h[eloc] - save_h[bloc];
    p.uline_variant  = ULINE_REVERSED;
    emit_primitive(p);
}

void json_print::put_w_uline(int bloc, int eloc)
{
    flush_run();
    ensure_system_open();

    JsonPrimitive p;
    p.type           = JPRIM_ULINE;
    p.uline_x        = save_h[bloc];
    p.uline_y        = dvi_v_to_y(dvi_v);
    p.uline_width    = save_h[eloc] - save_h[bloc];
    p.uline_variant  = ULINE_WIDE;
    emit_primitive(p);
}

/* ================================================================
 * Slants (ornament lines)
 * ================================================================ */

void json_print::put_thick_slant(int bloc, int eloc)
{
    flush_run();
    ensure_system_open();

    JsonPrimitive p;
    p.type         = JPRIM_SLANT;
    p.slant_x1     = save_h[bloc];
    p.slant_y1     = dvi_v_to_y(save_v[bloc]);
    p.slant_x2     = save_h[eloc];
    p.slant_y2     = dvi_v_to_y(save_v[eloc]);
    p.slant_weight = SLANT_THICK;
    emit_primitive(p);
}

void json_print::put_med_slant(int bloc, int eloc)
{
    flush_run();
    ensure_system_open();

    JsonPrimitive p;
    p.type         = JPRIM_SLANT;
    p.slant_x1     = save_h[bloc];
    p.slant_y1     = dvi_v_to_y(save_v[bloc]);
    p.slant_x2     = save_h[eloc];
    p.slant_y2     = dvi_v_to_y(save_v[eloc]);
    p.slant_weight = SLANT_MED;
    emit_primitive(p);
}

void json_print::put_slant(int bloc, int eloc)
{
    flush_run();
    ensure_system_open();

    JsonPrimitive p;
    p.type         = JPRIM_SLANT;
    p.slant_x1     = save_h[bloc];
    p.slant_y1     = dvi_v_to_y(save_v[bloc]);
    p.slant_x2     = save_h[eloc];
    p.slant_y2     = dvi_v_to_y(save_v[eloc]);
    p.slant_weight = SLANT_THIN;
    emit_primitive(p);
}

/* ================================================================
 * Curves (vertical slurs)
 * ================================================================ */

void json_print::vert_curve(int len)
{
    flush_run();
    ensure_system_open();

    JsonPrimitive p;
    p.type      = JPRIM_CURVE;
    p.curve_x   = dvi_h;
    p.curve_y   = dvi_v_to_y(dvi_v);
    p.curve_len = len;
    emit_primitive(p);
}

/* ================================================================
 * more() — controls the page-filling loop in main.cc/tfm_stuff.
 * Same logic as ps_print::more() — returns 1 (END_MORE) while there
 * is still content in the i_buf to process.
 * ================================================================ */

int json_print::more()
{
    double length;
    if      (red == 1.0)     length = 2.6;
    else if (red == 0.94440) length = 2.5;
    else if (red == 0.88880) length = 2.4;
    else if (red == 0.777770) length = 2.80;
    else                     length = 2.50;

    if (inch_to_dvi(length) > dvi_v) return 1;
    return 0;
}

/* ================================================================
 * p_num — bar number (same as ps_print: print into the font-1 font)
 * We delegate to set_a_char for each digit.
 * ================================================================ */

void json_print::p_num(int n)
{
    char string[16];
    int i;
    snprintf(string, sizeof(string), "%d", n);
    push();
    use_font(1);
    for (i = 0; i < (int)sizeof(string) && string[i]; i++)
        set_a_char((unsigned char)string[i]);
    flush_run();
    pop();
}

/* ================================================================
 * JSON serialisation
 * ================================================================ */

/*
 * json_string: append s to out with JSON escaping.
 * Handles ", \, and control characters.
 */
void json_print::json_string(std::string &out, const char *s)
{
    out += '"';
    for (const char *p = s; *p; p++) {
        unsigned char c = (unsigned char)*p;
        if      (c == '"')  { out += '\\'; out += '"'; }
        else if (c == '\\') { out += '\\'; out += '\\'; }
        else if (c == '\n') { out += '\\'; out += 'n'; }
        else if (c == '\r') { out += '\\'; out += 'r'; }
        else if (c == '\t') { out += '\\'; out += 't'; }
        else if (c < 0x20) {
            /* Other control chars as \uXXXX */
            char esc[8];
            snprintf(esc, sizeof(esc), "\\u%04x", c);
            out += esc;
        } else {
            out += (char)c;
        }
    }
    out += '"';
}

static void append_int(std::string &out, int v)
{
    char buf[32];
    snprintf(buf, sizeof(buf), "%d", v);
    out += buf;
}

static void append_double(std::string &out, double v)
{
    char buf[32];
    snprintf(buf, sizeof(buf), "%.1f", v);
    out += buf;
}

/*
 * write_json: serialise the accumulated LayoutResult to fname.
 *
 * We write directly to a FILE* rather than using i_buf to avoid the
 * Append-mode buffer-prepend pattern that ps_print uses (which requires
 * a complete in-memory PS header to be prepended).  For JSON we just
 * stream the result directly.
 */
void json_print::write_json(const char *fname)
{
    FILE *fp = fopen(fname, "w");
    if (!fp) {
        fprintf(stderr, "json_print: ERROR: cannot open output file '%s'\n", fname);
        return;
    }

    std::string out;
    out.reserve(65536);

    out += "{\n";
    out += "  \"schema_version\": 1,\n";
    out += "  \"page_width_dvi\": ";  append_int(out, page_width_dvi);  out += ",\n";
    out += "  \"page_height_dvi\": "; append_int(out, page_top_dvi);   out += ",\n";
    out += "  \"left_margin_dvi\": "; append_int(out, left_margin_dvi); out += ",\n";
    out += "  \"top_margin_dvi\": ";  append_int(out, top_margin_dvi);  out += ",\n";
    out += "  \"staff_len_dvi\": ";   append_int(out, staff_len_dvi);   out += ",\n";

    /* fonts array */
    out += "  \"fonts\": [\n";
    for (size_t fi = 0; fi < font_manifest.size(); fi++) {
        const JsonFontDesc &fd = font_manifest[fi];
        out += "    {\"font_id\": ";
        append_int(out, fd.font_id);
        out += ", \"family\": ";
        json_string(out, fd.family.c_str());
        out += ", \"type\": ";
        json_string(out, fd.type.c_str());
        if (fd.has_size) {
            out += ", \"size_pt\": ";
            append_double(out, fd.size_pt);
        }
        out += "}";
        if (fi + 1 < font_manifest.size()) out += ",";
        out += "\n";
    }
    out += "  ],\n";

    /* pages array */
    out += "  \"pages\": [\n";
    for (size_t pi = 0; pi < pages.size(); pi++) {
        const JsonPage &pg = pages[pi];
        out += "    {\n";
        out += "      \"page_num\": "; append_int(out, pg.page_num); out += ",\n";
        out += "      \"systems\": [\n";

        for (size_t si = 0; si < pg.systems.size(); si++) {
            const JsonSystem &sys = pg.systems[si];
            out += "        {\n";
            out += "          \"system_num\": "; append_int(out, sys.system_num); out += ",\n";
            out += "          \"primitives\": [\n";

            for (size_t pri = 0; pri < sys.primitives.size(); pri++) {
                const JsonPrimitive &prim = sys.primitives[pri];
                out += "            ";

                switch (prim.type) {
                case JPRIM_GLYPH:
                    out += "{\"type\": \"glyph\", \"font_id\": ";
                    append_int(out, prim.glyph_font_id);
                    out += ", \"char_code\": ";
                    append_int(out, prim.glyph_char_code);
                    out += ", \"x\": "; append_int(out, prim.glyph_x);
                    out += ", \"y\": "; append_int(out, prim.glyph_y);
                    out += "}";
                    break;

                case JPRIM_TEXT_RUN:
                    out += "{\"type\": \"text_run\", \"font_id\": ";
                    append_int(out, prim.run_font_id);
                    out += ", \"x\": "; append_int(out, prim.run_x);
                    out += ", \"y\": "; append_int(out, prim.run_y);
                    out += ", \"text\": ";
                    json_string(out, prim.run_text.c_str());
                    out += "}";
                    break;

                case JPRIM_RULE:
                    out += "{\"type\": \"rule\"";
                    out += ", \"x\": "; append_int(out, prim.rule_x);
                    out += ", \"y\": "; append_int(out, prim.rule_y);
                    out += ", \"width\": "; append_int(out, prim.rule_width);
                    out += ", \"height\": "; append_int(out, prim.rule_height);
                    out += "}";
                    break;

                case JPRIM_TIE: {
                    const char *variant = "normal";
                    if (prim.tie_variant == TIE_REVERSED) variant = "reversed";
                    else if (prim.tie_variant == TIE_HALF) variant = "half";
                    else if (prim.tie_variant == TIE_HALF_REVERSED) variant = "half_reversed";
                    out += "{\"type\": \"tie\"";
                    out += ", \"x\": "; append_int(out, prim.tie_x);
                    out += ", \"y\": "; append_int(out, prim.tie_y);
                    out += ", \"length\": "; append_int(out, prim.tie_length);
                    out += ", \"variant\": \""; out += variant; out += "\"";
                    out += "}";
                    break;
                }

                case JPRIM_RTIE:
                    out += "{\"type\": \"rtie\"";
                    out += ", \"x\": "; append_int(out, prim.tie_x);
                    out += ", \"y\": "; append_int(out, prim.tie_y);
                    out += ", \"length\": "; append_int(out, prim.tie_length);
                    out += "}";
                    break;

                case JPRIM_SLASH:
                    out += "{\"type\": \"slash\"";
                    out += ", \"x\": "; append_int(out, prim.slash_x);
                    out += ", \"y\": "; append_int(out, prim.slash_y);
                    out += ", \"width\": "; append_int(out, prim.slash_width);
                    out += ", \"count\": "; append_int(out, prim.slash_count);
                    out += "}";
                    break;

                case JPRIM_ULINE: {
                    const char *variant = "normal";
                    if (prim.uline_variant == ULINE_REVERSED) variant = "reversed";
                    else if (prim.uline_variant == ULINE_WIDE) variant = "wide";
                    out += "{\"type\": \"uline\"";
                    out += ", \"x\": "; append_int(out, prim.uline_x);
                    out += ", \"y\": "; append_int(out, prim.uline_y);
                    out += ", \"width\": "; append_int(out, prim.uline_width);
                    out += ", \"variant\": \""; out += variant; out += "\"";
                    out += "}";
                    break;
                }

                case JPRIM_SLANT: {
                    const char *weight = "thin";
                    if (prim.slant_weight == SLANT_MED)   weight = "medium";
                    else if (prim.slant_weight == SLANT_THICK) weight = "thick";
                    out += "{\"type\": \"slant\"";
                    out += ", \"x1\": "; append_int(out, prim.slant_x1);
                    out += ", \"y1\": "; append_int(out, prim.slant_y1);
                    out += ", \"x2\": "; append_int(out, prim.slant_x2);
                    out += ", \"y2\": "; append_int(out, prim.slant_y2);
                    out += ", \"weight\": \""; out += weight; out += "\"";
                    out += "}";
                    break;
                }

                case JPRIM_CURVE:
                    out += "{\"type\": \"curve\"";
                    out += ", \"x\": "; append_int(out, prim.curve_x);
                    out += ", \"y\": "; append_int(out, prim.curve_y);
                    out += ", \"length\": "; append_int(out, prim.curve_len);
                    out += "}";
                    break;
                }

                if (pri + 1 < sys.primitives.size()) out += ",";
                out += "\n";
            }

            out += "          ]\n";
            out += "        }";
            if (si + 1 < pg.systems.size()) out += ",";
            out += "\n";
        }

        out += "      ]\n";
        out += "    }";
        if (pi + 1 < pages.size()) out += ",";
        out += "\n";
    }
    out += "  ],\n";

    /* anchors array — per-system source-line -> typeset-position mapping,
     * for the frontend's editor-scroll-sync feature. */
    out += "  \"anchors\": [\n";
    for (size_t ai = 0; ai < anchors.size(); ai++) {
        const JsonAnchor &a = anchors[ai];
        out += "    {\"line\": "; append_int(out, a.line);
        out += ", \"page\": "; append_int(out, a.page);
        out += ", \"y\": "; append_int(out, a.y);
        out += "}";
        if (ai + 1 < anchors.size()) out += ",";
        out += "\n";
    }
    out += "  ],\n";

    /* errors[] is always empty in Phase 1 (one-shot CLI mode).
     * The bun-side parseTabErrors() reads stderr for errors, so this
     * doesn't break existing behaviour.  Phase 2 will hook dbg(Error,...)
     * into a sink here when it replaces exit() with longjmp — that work
     * is deferred because it requires the same dbg.cc changes Phase 2
     * already owns (replacing exit() with per-request longjmp). */
    out += "  \"errors\": []\n";
    out += "}\n";

    fwrite(out.c_str(), 1, out.size(), fp);
    fclose(fp);
}

/*
 * write_json_worker: emit a compact single-line JSON response to stdout.
 *
 * The schema is identical to write_json but:
 *   - No pretty-printing (no embedded newlines), so bun's NDJSON iterator
 *     sees exactly one JSON object per line.
 *   - Writes to stdout followed by '\n'.
 *   - Includes the errors[] array from the caller-supplied sink.
 *
 * Single-line guarantee: json_string() already escapes \n as \\n, so string
 * values can never introduce literal newlines.  Numeric values never contain
 * newlines.  The only structural characters are '{', '}', '[', ']', ':', ','
 * which are safe.
 */
void json_print::write_json_worker(const std::vector<CompilationError> &errors)
{
    std::string out;
    out.reserve(65536);

    out += "{\"schema_version\":1";
    out += ",\"page_width_dvi\":";  append_int(out, page_width_dvi);
    out += ",\"page_height_dvi\":"; append_int(out, page_top_dvi);
    out += ",\"left_margin_dvi\":"; append_int(out, left_margin_dvi);
    out += ",\"top_margin_dvi\":";  append_int(out, top_margin_dvi);
    out += ",\"staff_len_dvi\":";   append_int(out, staff_len_dvi);

    /* fonts array */
    out += ",\"fonts\":[";
    for (size_t fi = 0; fi < font_manifest.size(); fi++) {
        const JsonFontDesc &fd = font_manifest[fi];
        if (fi > 0) out += ",";
        out += "{\"font_id\":";
        append_int(out, fd.font_id);
        out += ",\"family\":";
        json_string(out, fd.family.c_str());
        out += ",\"type\":";
        json_string(out, fd.type.c_str());
        if (fd.has_size) {
            out += ",\"size_pt\":";
            append_double(out, fd.size_pt);
        }
        out += "}";
    }
    out += "]";

    /* pages array */
    out += ",\"pages\":[";
    for (size_t pi = 0; pi < pages.size(); pi++) {
        const JsonPage &pg = pages[pi];
        if (pi > 0) out += ",";
        out += "{\"page_num\":"; append_int(out, pg.page_num);
        out += ",\"systems\":[";

        for (size_t si = 0; si < pg.systems.size(); si++) {
            const JsonSystem &sys = pg.systems[si];
            if (si > 0) out += ",";
            out += "{\"system_num\":"; append_int(out, sys.system_num);
            out += ",\"primitives\":[";

            for (size_t pri = 0; pri < sys.primitives.size(); pri++) {
                const JsonPrimitive &prim = sys.primitives[pri];
                if (pri > 0) out += ",";

                switch (prim.type) {
                case JPRIM_GLYPH:
                    out += "{\"type\":\"glyph\",\"font_id\":";
                    append_int(out, prim.glyph_font_id);
                    out += ",\"char_code\":"; append_int(out, prim.glyph_char_code);
                    out += ",\"x\":"; append_int(out, prim.glyph_x);
                    out += ",\"y\":"; append_int(out, prim.glyph_y);
                    out += "}";
                    break;

                case JPRIM_TEXT_RUN:
                    out += "{\"type\":\"text_run\",\"font_id\":";
                    append_int(out, prim.run_font_id);
                    out += ",\"x\":"; append_int(out, prim.run_x);
                    out += ",\"y\":"; append_int(out, prim.run_y);
                    out += ",\"text\":";
                    json_string(out, prim.run_text.c_str());
                    out += "}";
                    break;

                case JPRIM_RULE:
                    out += "{\"type\":\"rule\"";
                    out += ",\"x\":"; append_int(out, prim.rule_x);
                    out += ",\"y\":"; append_int(out, prim.rule_y);
                    out += ",\"width\":"; append_int(out, prim.rule_width);
                    out += ",\"height\":"; append_int(out, prim.rule_height);
                    out += "}";
                    break;

                case JPRIM_TIE: {
                    const char *variant = "normal";
                    if (prim.tie_variant == TIE_REVERSED) variant = "reversed";
                    else if (prim.tie_variant == TIE_HALF) variant = "half";
                    else if (prim.tie_variant == TIE_HALF_REVERSED) variant = "half_reversed";
                    out += "{\"type\":\"tie\"";
                    out += ",\"x\":"; append_int(out, prim.tie_x);
                    out += ",\"y\":"; append_int(out, prim.tie_y);
                    out += ",\"length\":"; append_int(out, prim.tie_length);
                    out += ",\"variant\":\""; out += variant; out += "\"";
                    out += "}";
                    break;
                }

                case JPRIM_RTIE:
                    out += "{\"type\":\"rtie\"";
                    out += ",\"x\":"; append_int(out, prim.tie_x);
                    out += ",\"y\":"; append_int(out, prim.tie_y);
                    out += ",\"length\":"; append_int(out, prim.tie_length);
                    out += "}";
                    break;

                case JPRIM_SLASH:
                    out += "{\"type\":\"slash\"";
                    out += ",\"x\":"; append_int(out, prim.slash_x);
                    out += ",\"y\":"; append_int(out, prim.slash_y);
                    out += ",\"width\":"; append_int(out, prim.slash_width);
                    out += ",\"count\":"; append_int(out, prim.slash_count);
                    out += "}";
                    break;

                case JPRIM_ULINE: {
                    const char *variant = "normal";
                    if (prim.uline_variant == ULINE_REVERSED) variant = "reversed";
                    else if (prim.uline_variant == ULINE_WIDE) variant = "wide";
                    out += "{\"type\":\"uline\"";
                    out += ",\"x\":"; append_int(out, prim.uline_x);
                    out += ",\"y\":"; append_int(out, prim.uline_y);
                    out += ",\"width\":"; append_int(out, prim.uline_width);
                    out += ",\"variant\":\""; out += variant; out += "\"";
                    out += "}";
                    break;
                }

                case JPRIM_SLANT: {
                    const char *weight = "thin";
                    if (prim.slant_weight == SLANT_MED)   weight = "medium";
                    else if (prim.slant_weight == SLANT_THICK) weight = "thick";
                    out += "{\"type\":\"slant\"";
                    out += ",\"x1\":"; append_int(out, prim.slant_x1);
                    out += ",\"y1\":"; append_int(out, prim.slant_y1);
                    out += ",\"x2\":"; append_int(out, prim.slant_x2);
                    out += ",\"y2\":"; append_int(out, prim.slant_y2);
                    out += ",\"weight\":\""; out += weight; out += "\"";
                    out += "}";
                    break;
                }

                case JPRIM_CURVE:
                    out += "{\"type\":\"curve\"";
                    out += ",\"x\":"; append_int(out, prim.curve_x);
                    out += ",\"y\":"; append_int(out, prim.curve_y);
                    out += ",\"length\":"; append_int(out, prim.curve_len);
                    out += "}";
                    break;
                }
            }

            out += "]}";  /* close primitives and system */
        }

        out += "]}";  /* close systems and page */
    }
    out += "]";  /* close pages */

    /* anchors array */
    out += ",\"anchors\":[";
    for (size_t ai = 0; ai < anchors.size(); ai++) {
        const JsonAnchor &a = anchors[ai];
        if (ai > 0) out += ",";
        out += "{\"line\":"; append_int(out, a.line);
        out += ",\"page\":"; append_int(out, a.page);
        out += ",\"y\":"; append_int(out, a.y);
        out += "}";
    }
    out += "]";

    /* errors array */
    out += ",\"errors\":[";
    for (size_t ei = 0; ei < errors.size(); ei++) {
        if (ei > 0) out += ",";
        out += "{\"line\":";
        char nbuf[32];
        snprintf(nbuf, sizeof(nbuf), "%d", errors[ei].line);
        out += nbuf;
        out += ",\"message\":";
        json_string(out, errors[ei].message.c_str());
        out += "}";
    }
    out += "]";

    out += "}\n";  /* single newline terminates the NDJSON line */

    fwrite(out.c_str(), 1, out.size(), stdout);
    fflush(stdout);
}
