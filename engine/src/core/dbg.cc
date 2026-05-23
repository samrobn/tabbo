#include "win.h"
#include <stdlib.h>
#include "dbg.h"
#include "worker_types.h"
#include <stdio.h>

int debug_flag=0;

/* ---- Worker-mode error state ---- */
/* g_worker_mode: set to 1 when -worker flag is active.  When set, dbg(Error,...)
 * appends to g_error_sink and longjmps to g_error_jmp instead of calling
 * exit().  Non-error severities are unaffected. */
int g_worker_mode = 0;
jmp_buf g_error_jmp;
std::vector<CompilationError> g_error_sink;

/* g_error_jmp_armed: guards against longjmp to an uninitialised g_error_jmp.
 * Set to 1 just before each setjmp(g_error_jmp) in the worker dispatch loop,
 * cleared to 0 after each command completes (or after the longjmp returns).
 * If handle_error() fires while this is 0 (e.g. during args() parsing before
 * the per-request setjmp is established), we print to stderr and exit(1)
 * rather than longjmping to a garbage jmp_buf. */
int g_error_jmp_armed = 0;

void dbg_set(const dbg_type type)
{
    debug_flag |= type;
}

/*
 * handle_error: shared exit/longjmp path for all dbg* variants when
 * type == Error.  In worker mode we longjmp so the worker loop can emit an
 * error envelope and continue.  In one-shot CLI mode we exit as before.
 *
 * Destructors: the C++ objects between the worker command-dispatch frame and
 * any dbg(Error,...) call site are:
 *   - json_print (heap-allocated via new inside tfm_stuff) — NOT on the stack
 *   - font_list*[] array in tfm_stuff — plain pointer array (trivial)
 *   - i_buf b in worker_run_layout — heap-allocated via new
 *   - std::string line buffer in run_worker_loop — stack, but longjmp target
 *     is set BEFORE that scope in the outer dispatch frame which has no C++
 *     objects with non-trivial destructors
 * The only C++ objects present at longjmp unwinding that have destructors are
 * those inside the tfm_stuff / format_page call chain itself.  These are all
 * heap-allocated or primitive.  Confirmed safe.
 */
static void handle_error()
{
    if (g_worker_mode && g_error_jmp_armed) {
        longjmp(g_error_jmp, 1);
    } else if (g_worker_mode && !g_error_jmp_armed) {
        /* Worker mode but no setjmp established yet (e.g. error during
         * args() parsing before per-request dispatch begins).  The error
         * message is already on stderr via the dbg* caller above.  Exit
         * cleanly rather than longjmping to an uninitialised jmp_buf. */
        exit(1);
    } else {
        exit(-1);
    }
}

void dbg5(const int type, const char *fmt,
	  void *a, void *b, void *c, void *d, void *e)
{
    if (type & debug_flag) {
#ifdef MAC
	my_printf ( fmt, a, b, c, d, e);
#else
        /* In worker mode route all diagnostics to stderr so stdout stays
         * clean NDJSON.  In one-shot CLI mode keep existing printf behaviour
         * (the desktop app reads stderr for error messages). */
        if (g_worker_mode)
            fprintf(stderr, fmt, a, b, c, d, e);
        else
	    printf ( fmt, a, b, c, d, e);
#endif
    }
    if (type == Error) {
        if (g_worker_mode) {
            /* Collect the error into the per-request sink for inclusion in
             * the JSON errors[] response.  We don't have a source line number
             * at this level; callers that know the line call higher-level
             * helpers — for now record line 0. */
            char buf[512];
            snprintf(buf, sizeof(buf), fmt, a, b, c, d, e);
            CompilationError ce;
            ce.line = 0;
            ce.message = buf;
            g_error_sink.push_back(ce);
        }
        handle_error();
    }
}

void dbg4(const int type, const char *fmt,
	  void *a, void *b, void *c, void *d)
{
    if (type & debug_flag) {
#ifdef MAC
	my_printf (fmt, a, b, c, d);
#else
        if (g_worker_mode)
            fprintf(stderr, fmt, a, b, c, d);
        else
	    printf ( fmt, a, b, c, d);
#endif
    }
    if (type == Error) {
        if (g_worker_mode) {
            char buf[512];
            snprintf(buf, sizeof(buf), fmt, a, b, c, d);
            CompilationError ce;
            ce.line = 0;
            ce.message = buf;
            g_error_sink.push_back(ce);
        }
        handle_error();
    }
}

void dbg3(const int type, const char *fmt, void *a, void *b, void *c)
{
    if (type & debug_flag) {
#ifdef MAC
	my_printf (fmt, a, b, c);
#else
        if (g_worker_mode)
            fprintf(stderr, fmt, a, b, c);
        else
	    printf ( fmt, a, b, c);
#endif
    }
    if (type == Error) {
        if (g_worker_mode) {
            char buf[512];
            snprintf(buf, sizeof(buf), fmt, a, b, c);
            CompilationError ce;
            ce.line = 0;
            ce.message = buf;
            g_error_sink.push_back(ce);
        }
        handle_error();
    }
}

void dbg2(const int type, const char *fmt, void *a, void *b)
{
    if (type & debug_flag) {
#ifdef MAC
	my_printf (fmt, a, b);
#else
        if (g_worker_mode)
            fprintf(stderr, fmt, a, b);
        else
	    printf ( fmt, a, b);
#endif
    }
    if (type == Error) {
        if (g_worker_mode) {
            char buf[512];
            snprintf(buf, sizeof(buf), fmt, a, b);
            CompilationError ce;
            ce.line = 0;
            ce.message = buf;
            g_error_sink.push_back(ce);
        }
        handle_error();
    }
}

void dbg1(const int type, const char *fmt, void *a)
{
    if (type & debug_flag) {
#ifdef MAC
	my_printf (fmt, a);
#else
        if (g_worker_mode)
            fprintf(stderr, fmt, a);
        else
	    printf ( fmt, a);
#endif
    }
    if (type == Error) {
        if (g_worker_mode) {
            char buf[512];
            snprintf(buf, sizeof(buf), fmt, a);
            CompilationError ce;
            ce.line = 0;
            ce.message = buf;
            g_error_sink.push_back(ce);
        }
        handle_error();
    }
}

void dbg0(const int type, const char *fmt)
{
    if (type & debug_flag) {
#ifdef MAC
	my_printf (fmt);
#else
        if (g_worker_mode)
            fprintf(stderr, "%s", fmt);
        else
	    printf (fmt);
#endif
    }
    if (type == Error) {
        if (g_worker_mode) {
            CompilationError ce;
            ce.line = 0;
            ce.message = fmt;
            g_error_sink.push_back(ce);
        }
        handle_error();
    }
}
