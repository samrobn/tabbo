/*
 * worker.cc — long-lived NDJSON worker mode for the tab typesetter.
 *
 * Activated by the -worker CLI flag.  The worker:
 *   1. Enters a command loop, reading one JSON object per line from stdin.
 *   2. Dispatches each command, writes one JSON response line to stdout.
 *   3. Loops until stdin EOF, then exits 0.
 *
 * Stdout is exclusively NDJSON.  All diagnostics go to stderr (enforced by
 * the g_worker_mode flag in dbg.cc).
 *
 * Per-request error recovery:
 *   dbg(Error,...) appends to g_error_sink and longjmps to g_error_jmp
 *   (set up in worker_run_layout) rather than calling exit().  The longjmp
 *   target emits an error envelope and continues the loop.
 *
 * Destructor audit (longjmp safety):
 *   The worker dispatch frame worker_run_layout holds on its stack:
 *     - char tmppath[]           — POD array
 *     - i_buf *b                 — pointer (heap object)
 *     - file_in *fi              — pointer (heap object)
 *   The file_info *f passed in is heap-allocated by main().
 *   No C++ objects with non-trivial destructors exist on the stack between
 *   the setjmp site and any dbg(Error,...) callsite in the engine call chain.
 *   The json_print object is heap-allocated inside tfm_stuff() and will leak
 *   on error paths — this is acceptable (error path only; fonts are reused).
 *   The i_buf and file_in pointers also leak on error paths, similarly
 *   acceptable.  The temp file may not be removed on error; it is overwritten
 *   on the next request so this causes no correctness problem.
 */

#include "win.h"
#include "tab.h"
#include "i_buf.h"
#include "file_in.h"
#include "print.h"
#include "json_print.h"

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <string>
#ifndef _MSC_VER
#include <unistd.h>
#endif

/* ---- Globals from other translation units ---- */
extern int  baroque;
extern int  thin_renaissance;
extern int  n_system;
extern int  bar_count;
extern int  barCount;
extern int  barCCount;
extern int  pagenum;
extern double red;
extern struct list *listh;
extern int  n_measures;

/* sizes.cc mutable globals */
extern double staff_len;
extern double o_staff_len;
extern double m_space;
extern char   interspace[];
extern char   staff_height[];

/* forward declarations */
void init(file_info *f);
void tfm_stuff(i_buf *b, file_info *f);
void get_tab_file(file_in *fi, i_buf *ib, struct file_info *f);

/* Reset functions defined in each translation unit */
extern void reset_pass1_statics(void);
extern void reset_tab_p_statics(void);
extern void reset_dvi_f_statics(void);
extern void reset_getsys_statics(void);
extern void reset_pass2_statics(void);
extern void reset_get_t_statics(void);

/* ====================================================================
 * reset_engine_state
 *
 * Reset all per-request statics and mutable globals to their program-start
 * values.  Called at the start of each layout command.
 * ==================================================================== */
void reset_engine_state(file_info *f)
{
    /* ---- main.cc globals ---- */
    baroque          = 0;
    thin_renaissance = 0;
    n_system         = 0;
    bar_count        = 0;
    barCount         = 0;
    barCCount        = 0;
    pagenum          = 0;
    red              = 1.0;

    /* ---- sizes.cc globals ---- */
    staff_len   = 6.5;
    o_staff_len = 6.5;
    n_measures  = 0;
    m_space     = 0.09;
    /* interspace and staff_height are char arrays; reset to initial values.
     * interspace default is "10.00 pt" (from sizes.cc initialiser).
     * staff_height: init() appends "0.0057 in" to whatever is in the buffer
     * so we must clear it first. */
    strncpy(interspace,  "10.00 pt", sizeof("10.00 pt"));
    staff_height[0] = '\0';

    /* listh must be NULL entering each layout pass */
    listh = NULL;

    /* Re-initialise file_info to per-request defaults.
     *
     * We cannot call init(f) here because:
     *   (a) init() calls malloc() for f->file and f->out_file, leaking the
     *       existing buffers which are still valid for this session.
     *   (b) init() zeroes f->flags and f->m_flags, wiping WORKER_MODE,
     *       JSON_OUT, QUIET, and NO_INCLUDES which must persist across requests.
     *
     * Instead, reset only the per-request fields while preserving the fields
     * that are set once at startup (flags, file buffers, font names). */
    f->line_flag  = BETWEEN_LINE;
    f->flag_flag  = STAND_FLAGS;
    f->char_flag  = STAND_CHAR;
    f->num_flag   = STAND_NUM;
    f->note_conv  = 0;
    f->c_space    = 0.045;
    f->note_flag  = MOD_NOTES;
    f->sys_skip   = 0.0;
    f->cur_system = 0;
    f->n_text     = 0;
    f->page       = 0;
    f->include    = 0;
    f->start_system = 0;
    f->transpose  = 0;
    f->bar_number_font = 1;
    f->slur_depth = -1.20;
    /* scribe and title may be malloc'd during processing (tree.cc, title.cc).
     * Free before nulling to avoid per-request leak. */
    if (f->scribe) { free(f->scribe); f->scribe = NULL; }
    if (f->title)  { free(f->title);  f->title  = NULL; }
    f->left_margin = 72;
    f->top_margin  = 72;
    f->extended_character_set = 0;
    f->midi_patch  = 0;
    f->midi_volume = 110;
    f->font_sizes[0] = 0.0;
    f->font_sizes[1] = 10.0;
    f->font_sizes[2] = 12.0;
    f->font_sizes[3] = 12.0;
    f->font_sizes[4] = 24.0;
    f->font_sizes[5] = 10.0;
    f->font_sizes[6] = 17.0;
    f->font_sizes[7] = 0.0;
    /* Reset all per-request flags while preserving startup flags.
     * Worker needs: JSON_OUT, WORKER_MODE, QUIET, NO_INCLUDES always set. */
    f->flags   = PS | DPI600;  /* base output flags for JSON path */
    f->m_flags = JSON_OUT | WORKER_MODE | QUIET | NO_INCLUDES;
    /* font_names: may be malloc'd by $lutefont/$textfont etc. directives
     * during processing.  Free before nulling to avoid per-request leak.
     * Note: strlen(value) without +1 is a pre-existing off-by-one in the
     * malloc callers — do not fix here (out of scope). */
    for (int fi2 = 0; fi2 < FONT_NAMES; fi2++) {
        if (f->font_names[fi2]) free(f->font_names[fi2]);
        f->font_names[fi2] = 0;
    }
    /* staff_height: init() appended "0.0057 in"; we cleared it above, so
     * re-append the default here (mirrors init() behaviour). */
    strncat(staff_height, "0.0057 in", 80);

    /* Reset per-TU statics */
    reset_pass1_statics();
    reset_tab_p_statics();
    reset_dvi_f_statics();
    reset_getsys_statics();
    reset_pass2_statics();
    reset_get_t_statics();

    /* Dormant statics not yet reset (YAGNI — currently unreachable in the
     * JSON-mode worker path which bypasses pk/tfm bitmap loading):
     *
     *   pk_font.cc globals: bits[257], pk_buf, pk_ptr, pk_bufsize,
     *     max_b_w, max_b_h, max_off_w, max_off_h
     *   tfm.cc: font_path (pointer to argv string — not malloc'd, safe)
     *
     * If pk/tfm state is ever touched in worker mode (e.g. if the worker
     * gains a binary-font output path), add reset functions here.
     */
}

/* ====================================================================
 * Minimal JSON helpers
 * ==================================================================== */

/* Emit a JSON-safe version of message as the sole error in an error envelope.
 * Writes a complete NDJSON line to stdout and flushes. */
static void emit_error_response(const char *message)
{
    /* Escape the message for JSON string embedding */
    std::string escaped;
    for (const char *p = message; *p; p++) {
        if (*p == '"')       { escaped += '\\'; escaped += '"'; }
        else if (*p == '\\') { escaped += '\\'; escaped += '\\'; }
        else if (*p == '\n') { escaped += '\\'; escaped += 'n'; }
        else if (*p == '\r') { escaped += '\\'; escaped += 'r'; }
        else                  { escaped += *p; }
    }
    fprintf(stdout,
        "{\"schema_version\":1,\"page_width_dvi\":0,\"page_height_dvi\":0,"
        "\"left_margin_dvi\":0,\"top_margin_dvi\":0,\"staff_len_dvi\":0,"
        "\"fonts\":[],\"pages\":[],"
        "\"errors\":[{\"line\":0,\"message\":\"%s\"}]}\n",
        escaped.c_str());
    fflush(stdout);
}

/* Emit an error envelope from g_error_sink (may have multiple errors). */
static void emit_error_sink_response(void)
{
    if (g_error_sink.empty()) {
        emit_error_response("engine error (no diagnostic)");
        return;
    }
    std::string out;
    out.reserve(512);
    out += "{\"schema_version\":1,\"page_width_dvi\":0,\"page_height_dvi\":0,"
           "\"left_margin_dvi\":0,\"top_margin_dvi\":0,\"staff_len_dvi\":0,"
           "\"fonts\":[],\"pages\":[],\"errors\":[";
    for (size_t i = 0; i < g_error_sink.size(); i++) {
        if (i > 0) out += ',';
        out += "{\"line\":";
        char nbuf[32];
        snprintf(nbuf, sizeof(nbuf), "%d", g_error_sink[i].line);
        out += nbuf;
        out += ",\"message\":\"";
        for (char c : g_error_sink[i].message) {
            if (c == '"')       { out += '\\'; out += '"'; }
            else if (c == '\\') { out += '\\'; out += '\\'; }
            else if (c == '\n') { out += '\\'; out += 'n'; }
            else if (c == '\r') { out += '\\'; out += 'r'; }
            else                 { out += c; }
        }
        out += "\"}";
    }
    out += "]}\n";
    fwrite(out.c_str(), 1, out.size(), stdout);
    fflush(stdout);
}

/* ====================================================================
 * Tiny NDJSON command parser
 *
 * Extracts "cmd" and (optionally) "content" from a line of the form:
 *   {"cmd":"version"}
 *   {"cmd":"layout","content":"<tab source>"}
 *
 * Returns true on success, false if the line is not parseable or missing
 * "cmd".  Does not validate JSON beyond what is needed.
 * ==================================================================== */

static const char *skip_ws(const char *p)
{
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    return p;
}

/* Parse a JSON string literal starting at '"'.  Returns pointer past the
 * closing '"', or NULL on error.  Appends decoded value to out. */
static const char *parse_json_string(const char *p, std::string &out)
{
    if (*p != '"') return NULL;
    p++;
    while (*p && *p != '"') {
        if (*p == '\\') {
            p++;
            if (!*p) return NULL;
            switch (*p) {
            case '"':  out += '"';  p++; break;
            case '\\': out += '\\'; p++; break;
            case '/':  out += '/';  p++; break;
            case 'n':  out += '\n'; p++; break;
            case 'r':  out += '\r'; p++; break;
            case 't':  out += '\t'; p++; break;
            case 'u': {
                p++;
                if (strlen(p) < 4) return NULL;
                char hex[5] = {p[0], p[1], p[2], p[3], 0};
                int cp = (int)strtol(hex, NULL, 16);
                p += 4;
                if (cp < 0x80) {
                    out += (char)cp;
                } else if (cp < 0x800) {
                    out += (char)(0xC0 | (cp >> 6));
                    out += (char)(0x80 | (cp & 0x3F));
                } else {
                    out += (char)(0xE0 | (cp >> 12));
                    out += (char)(0x80 | ((cp >> 6) & 0x3F));
                    out += (char)(0x80 | (cp & 0x3F));
                }
                break;
            }
            default:
                out += *p;
                p++;
                break;
            }
        } else {
            out += *p++;
        }
    }
    if (*p != '"') return NULL;
    return p + 1;
}

/* parse_worker_command: extract cmd and content from one JSON object.
 * Returns true on success.  *end_out is set to the position immediately
 * after the closing '}' so the caller can detect trailing content (M5). */
static bool parse_worker_command(const char *line,
                                  std::string &cmd,
                                  std::string &content,
                                  const char **end_out)
{
    const char *p = skip_ws(line);
    if (*p != '{') return false;
    p++;
    bool got_cmd = false;

    while (true) {
        p = skip_ws(p);
        if (*p == '}') { p++; break; }
        if (*p == ',') { p++; p = skip_ws(p); }
        if (*p != '"') return false;

        std::string key;
        p = parse_json_string(p, key);
        if (!p) return false;

        p = skip_ws(p);
        if (*p != ':') return false;
        p++;
        p = skip_ws(p);

        if (*p == '"') {
            std::string val;
            p = parse_json_string(p, val);
            if (!p) return false;
            if (key == "cmd") {
                cmd = val;
                got_cmd = true;
            } else if (key == "content") {
                content = val;
            }
        } else {
            /* Non-string value — skip to end of value */
            while (*p && *p != ',' && *p != '}') p++;
        }
    }

    if (end_out) *end_out = p;
    return got_cmd;
}

/* ====================================================================
 * Layout command handler
 * ==================================================================== */

/*
 * worker_run_layout: run one complete parse+layout cycle for content.
 *
 * Writes a single JSON response line to stdout.  On engine error (longjmp),
 * emits an error envelope and returns.  On success, the json_print destructor
 * (called inside tfm_stuff) emits the response via write_json_worker.
 */
static void worker_run_layout(const std::string &content, file_info *f)
{
    /* Clear the per-request error sink */
    g_error_sink.clear();

    /* Reset all per-request statics and globals */
    reset_engine_state(f);

    /* Establish the longjmp recovery point for this request.
     * If dbg(Error,...) fires anywhere during this request, setjmp returns
     * non-zero and we fall through to the error-envelope path.
     *
     * Arm the flag BEFORE setjmp so handle_error() can safely longjmp to
     * this frame.  The flag is cleared in both the normal and error paths
     * to prevent stale armed state between requests. */
    g_error_jmp_armed = 1;
    if (setjmp(g_error_jmp) != 0) {
        /* longjmp path: collect any errors and emit error envelope.
         * Note: json_print (if created) will leak — it's heap-allocated
         * inside tfm_stuff and its destructor won't run.  This is acceptable
         * for error paths in a worker context. */
        g_error_jmp_armed = 0;
        emit_error_sink_response();
        return;
    }

    /* Write content to a temporary file for file_in to read.
     * Use a process-unique path to avoid collisions with other instances. */
    char tmppath[256];
    snprintf(tmppath, sizeof(tmppath), "/tmp/tab_worker_%d.tab", (int)getpid());

    {
        FILE *fp = fopen(tmppath, "wb");
        if (!fp) {
            emit_error_response("worker: cannot create temporary input file");
            return;
        }
        if (!content.empty()) {
            fwrite(content.c_str(), 1, content.size(), fp);
        }
        /* Ensure file ends with newline so the pass1 EOF detection works */
        if (content.empty() || content.back() != '\n') {
            fputc('\n', fp);
        }
        fclose(fp);
    }

    /* Pass 1: read .tab source into the intermediate buffer */
    i_buf *b = new i_buf();

    /* Set f->file to the temp path so file_stuff / incl.cc can resolve paths.
     * f->file was allocated by init() with BUFSIZ bytes. */
    strncpy(f->file, tmppath, BUFSIZ - 1);
    f->file[BUFSIZ - 1] = '\0';

    file_in *fi = new file_in(tmppath, "rb");
    get_tab_file(fi, b, f);
    delete fi;

    b->Seek(0, rew);

    /* Pass 2 + JSON output: json_print is created inside tfm_stuff.
     * On normal completion, ~json_print() calls write_json_worker() which
     * emits the NDJSON response to stdout. */
    tfm_stuff(b, f);

    delete b;

    /* Clean up temp file */
    remove(tmppath);

    /* Disarm the longjmp guard now that this request has completed
     * successfully.  A subsequent dbg(Error,...) (e.g. during state reset
     * for the next request) must not jump back to this frame. */
    g_error_jmp_armed = 0;

    /* fflush is called inside write_json_worker; no need to repeat here. */
}

/* ====================================================================
 * Command dispatch
 * ==================================================================== */

static void handle_version_cmd(void)
{
    fprintf(stdout, "{\"schema_version\":1}\n");
    fflush(stdout);
}

static void handle_unknown_cmd(const std::string &cmd)
{
    std::string escaped;
    for (char c : cmd) {
        if (c == '"')       { escaped += '\\'; escaped += '"'; }
        else if (c == '\\') { escaped += '\\'; escaped += '\\'; }
        else                 { escaped += c; }
    }
    fprintf(stdout,
        "{\"schema_version\":1,\"page_width_dvi\":0,\"page_height_dvi\":0,"
        "\"left_margin_dvi\":0,\"top_margin_dvi\":0,\"staff_len_dvi\":0,"
        "\"fonts\":[],\"pages\":[],"
        "\"errors\":[{\"line\":0,\"message\":\"unknown command: %s\"}]}\n",
        escaped.c_str());
    fflush(stdout);
}

/* ====================================================================
 * Main worker loop
 * ==================================================================== */

/*
 * run_worker_loop: entered from main() when -worker flag is set.
 *
 * Reads NDJSON lines from stdin.  Dispatches each command.  Exits when stdin
 * reaches EOF.  Never exits on per-request errors — the loop is resilient.
 *
 * f is the file_info initialised by main() (init + args already called).
 */
void run_worker_loop(file_info *f)
{
    /* Growable line buffer — content strings can be several KB for large
     * scores, and much larger if the caller sends a big document. */
    size_t buf_cap = 65536;
    char  *buf     = (char *)malloc(buf_cap);
    if (!buf) {
        fprintf(stderr, "worker: failed to allocate line buffer\n");
        return;
    }

    while (true) {
        /* Read one complete line from stdin */
        size_t pos = 0;
        bool at_eof = false;

        while (true) {
            /* Grow buffer if needed (leave room for NUL) */
            if (pos + 2 >= buf_cap) {
                buf_cap *= 2;
                char *nb = (char *)realloc(buf, buf_cap);
                if (!nb) {
                    fprintf(stderr, "worker: line buffer realloc failed\n");
                    free(buf);
                    return;
                }
                buf = nb;
            }

            int ch = fgetc(stdin);
            if (ch == EOF) {
                at_eof = true;
                break;
            }
            if (ch == '\n') break;
            buf[pos++] = (char)ch;
        }
        buf[pos] = '\0';

        if (at_eof && pos == 0) break;  /* clean stdin EOF */
        if (pos == 0) continue;         /* skip empty lines */

        /* Parse and dispatch */
        std::string cmd, content;
        const char *parse_end = NULL;
        if (!parse_worker_command(buf, cmd, content, &parse_end)) {
            emit_error_response(
                "malformed JSON: could not extract {\"cmd\":...} from line");
            if (at_eof) break;
            continue;
        }

        /* M5: detect multiple JSON objects on one line.  After the closing '}'
         * of the parsed object, any non-whitespace means a second object was
         * concatenated — emit an error and discard the whole line rather than
         * silently dropping or double-processing. */
        if (parse_end) {
            const char *tail = skip_ws(parse_end);
            if (*tail != '\0') {
                emit_error_response(
                    "multiple JSON objects on one line -- split with newline");
                if (at_eof) break;
                continue;
            }
        }

        if (cmd == "version") {
            handle_version_cmd();
        } else if (cmd == "layout") {
            worker_run_layout(content, f);
        } else {
            handle_unknown_cmd(cmd);
        }

        if (at_eof) break;
    }

    free(buf);
}
