#pragma once
/*
 * worker_types.h — types shared between dbg.cc and the worker module.
 *
 * Split from tab.h so dbg.cc can include these without pulling in dbg_type
 * (which is defined in both tab.h and dbg.h, causing a redefinition error
 * when dbg.cc includes both).
 */

#include <string>
#include <vector>
#include <setjmp.h>

/* Per-request error record — matches the JSON errors[] schema. */
struct CompilationError {
    int line;
    std::string message;
};

/* Defined in dbg.cc. */
extern std::vector<CompilationError> g_error_sink;
extern jmp_buf g_error_jmp;
extern int     g_worker_mode;
extern int     g_error_jmp_armed;
