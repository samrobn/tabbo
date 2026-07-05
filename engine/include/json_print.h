#pragma once
#ifndef _JSON_PRINT_
#define _JSON_PRINT_

#include "print.h"
#include "tab.h"
#include <string>
#include <vector>

/* -----------------------------------------------------------------------
 * json_print — layout JSON output backend.
 *
 * Subclass of print.  Overrides all draw operations to accumulate a
 * structured LayoutResult (pages → systems → primitives) in memory, then
 * serialises once to a JSON file on destruction (same timing as ps_print).
 *
 * Coordinate system: DVI integer units throughout, top-left origin.
 * dvi_v increases downward (inherited base class decrements it on movev, so
 * we negate when storing y to convert to top-left origin).
 *
 * text_run aggregation: consecutive set_a_char calls in the same font at
 * positions consistent with TFM advance widths are coalesced into a single
 * text_run primitive.  Flushed on: font change, moveto, irregular moveh,
 * push/pop.
 * ----------------------------------------------------------------------- */

/* ---- primitive types ---- */

enum JsonPrimType {
    JPRIM_GLYPH,
    JPRIM_TEXT_RUN,
    JPRIM_RULE,
    JPRIM_TIE,
    JPRIM_RTIE,
    JPRIM_SLASH,
    JPRIM_ULINE,
    JPRIM_SLANT,
    JPRIM_CURVE
};

/* Variant tags for multi-variant primitives */
enum TieVariant  { TIE_NORMAL, TIE_REVERSED, TIE_HALF, TIE_HALF_REVERSED };
enum UlineVariant { ULINE_NORMAL, ULINE_REVERSED, ULINE_WIDE };
enum SlantWeight { SLANT_THIN, SLANT_MED, SLANT_THICK };

struct JsonPrimitive {
    JsonPrimType type;

    /* glyph */
    int   glyph_font_id;
    int   glyph_char_code;   /* PUA codepoint for font 0; raw codepoint otherwise */
    int   glyph_x;
    int   glyph_y;

    /* text_run */
    int   run_font_id;
    int   run_x;
    int   run_y;
    std::string run_text;    /* UTF-8 encoded string */

    /* rule */
    int   rule_x;
    int   rule_y;
    int   rule_width;
    int   rule_height;

    /* tie / rtie */
    int   tie_x;
    int   tie_y;
    int   tie_length;        /* for do_tie: inch_to_dvi result; for do_rtie: save_h delta */
    TieVariant tie_variant;

    /* slash */
    int   slash_x;
    int   slash_y;
    int   slash_width;       /* save_h[eloc] - save_h[bloc] */
    int   slash_count;

    /* uline */
    int   uline_x;
    int   uline_y;
    int   uline_width;
    UlineVariant uline_variant;

    /* slant */
    int   slant_x1;
    int   slant_y1;
    int   slant_x2;
    int   slant_y2;
    SlantWeight slant_weight;

    /* curve */
    int   curve_x;
    int   curve_y;
    int   curve_len;

    JsonPrimitive() :
        type(JPRIM_GLYPH),
        glyph_font_id(0), glyph_char_code(0), glyph_x(0), glyph_y(0),
        run_font_id(0), run_x(0), run_y(0),
        rule_x(0), rule_y(0), rule_width(0), rule_height(0),
        tie_x(0), tie_y(0), tie_length(0), tie_variant(TIE_NORMAL),
        slash_x(0), slash_y(0), slash_width(0), slash_count(0),
        uline_x(0), uline_y(0), uline_width(0), uline_variant(ULINE_NORMAL),
        slant_x1(0), slant_y1(0), slant_x2(0), slant_y2(0), slant_weight(SLANT_THIN),
        curve_x(0), curve_y(0), curve_len(0)
    {}
};

struct JsonSystem {
    int system_num;
    std::vector<JsonPrimitive> primitives;
    JsonSystem() : system_num(0) {}
};

struct JsonPage {
    int page_num;
    std::vector<JsonSystem> systems;
    JsonPage() : page_num(0) {}
};

/* One per typeset system: maps an original-source line back to where that
 * system landed, for the frontend's editor-scroll-sync feature. */
struct JsonAnchor {
    int line;   /* 1-based source line that triggered this system's parse */
    int page;   /* 1-based page number */
    int y;      /* top of system, DVI units, same space as primitives */
    JsonAnchor() : line(0), page(0), y(0) {}
};

struct JsonFontDesc {
    int    font_id;
    std::string family;
    std::string type;   /* "tab" or "text" */
    double size_pt;
    bool   has_size;
    JsonFontDesc() : font_id(0), size_pt(0.0), has_size(false) {}
};

class json_print : public print {
    /* document-level font manifest */
    std::vector<JsonFontDesc> font_manifest;
    bool font_seen[8];   /* indexed by font_id 0-7 */

    /* per-page/per-system accumulation */
    std::vector<JsonPage>  pages;
    int current_page_num;    /* 1-based */
    int current_system_num;  /* 0-based within page */
    bool page_open;

    /* editor-scroll-sync anchors, one per typeset system (see JsonAnchor) */
    std::vector<JsonAnchor> anchors;

    /* text_run aggregation state */
    bool   run_open;
    int    run_font;
    int    run_x;
    int    run_y;
    std::string run_text;
    int    run_last_advance;  /* TFM advance of last char, in DVI units */

    /* font array and file_info pointers (set at construction) */
    struct font_list **f_a;
    struct file_info  *f_i;

    /* output file name (from f_i->out_file) */
    char out_fname[BUFSIZ];

    /* page dimensions (DVI units) */
    int page_top_dvi;   /* ps_top_of_page equivalent */
    int page_width_dvi;
    int left_margin_dvi;
    int top_margin_dvi;
    int staff_len_dvi;

    /* page number tracking (incremented in do_page) */
    int npages;

    /* ---- internal helpers ---- */
    void record_font(int font_id);
    void flush_run();
    void ensure_system_open();
    void new_system_if_needed(int old_sp);
    JsonPage   &current_page();
    JsonSystem &current_system();
    void emit_primitive(const JsonPrimitive &p);

    /* JSON serialisation */
    void write_json(const char *fname);
    void write_json_worker(const std::vector<CompilationError> &errors);
    void json_string(std::string &out, const char *s);
    void json_utf8_codepoint(std::string &out, int cp);

    /* Worker-mode flag: when true, output goes to stdout as a single NDJSON
     * line instead of a pretty-printed file. */
    bool worker_mode;
    /* When true, the destructor skips write_json entirely.  Set on the
     * longjmp error path in worker mode to prevent corrupted output. */
    bool abandon_output;

    int dvi_v_to_y(int v) { return (page_top_dvi - v); }

public:
    json_print(font_list *f[], file_info *ff);
    ~json_print();

    /* Suppress write-on-destruct for the longjmp error path. */
    void abandon_without_write() { abandon_output = true; }

    /* --- virtual overrides required by print --- */
    void file_head()  {}
    void page_head()  {}
    void file_trail() {}
    void page_trail() {}

    int  do_page(i_buf *b, font_list *f_l[]);
    void begin_system(int source_line);

    void p_moveh(const int hor);
    void p_movev(const int ver);
    void p_moveto(const int hor, const int ver);
    void p_put_rule(int w, int h);

    void put_a_char(unsigned char c);
    void set_a_char(unsigned char c);
    void use_font(int fontnum);

    void do_tie(double length);
    void do_tie_reversed(double length);
    void do_half_tie(double length);
    void do_half_tie_reversed(double length);
    void do_rtie(int bloc, int eloc);

    void print_clipped(char c, int font) { (void)c; (void)font; }

    void glp(int reg, int h[], int v[]);
    void push();
    void pop();

    void put_slash(int bloc, int eloc, int count, struct file_info *f);
    void put_uline(int bloc, int eloc);
    void put_r_uline(int bloc, int eloc);
    void put_w_uline(int bloc, int eloc);
    void put_thick_slant(int bloc, int eloc);
    void put_med_slant(int bloc, int eloc);
    void put_slant(int bloc, int eloc);

    void vert_curve(int len);

    int  more();
    int  get_page_number() { return npages; }

    void showsave(int /*reg*/) {}
    void p_num(int n);
    void print_draft() {}
    void print_copyright() {}
    void comment(const char * /*s*/) {}
    void perfect()   {}
    void imperfect() {}
    void half_cross() {}
    void stroke()    {}
    void strokex()   {}
};

#endif /* _JSON_PRINT_ */
