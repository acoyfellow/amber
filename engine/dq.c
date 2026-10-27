/* dq.c: a tiny wasm-facing host for dquickts.
 *
 * One durable program per module instance. Exports (all return int status):
 *   dq_init()                      fresh runtime + context + natives
 *   dq_start(src, len, ts)         eval program; run until done / tool() / slice budget
 *   dq_resume(json, len)           feed a tool result (JSON) and keep running
 *   dq_save(delta)                 write snapshot (delta=1: delta vs base) -> dq_buf()/dq_buf_len()
 *   dq_restore(base,blen,d,dlen)   rebuild a runtime from base (+ delta)
 *   dq_make_base()                 write the reproducible base -> dq_buf()
 *   dq_set_budget(ticks)           suspend sync code after N interrupt ticks (0 = no limit)
 *   dq_out()/dq_out_len()          last JSON: pending call, result, or error
 * status: 0 done, 1 pending tool call, 2 slice (budget hit), -1 error
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include "quickjs.h"

#define EXPORT(name) __attribute__((export_name(#name)))

__attribute__((import_module("env"), import_name("host_log")))
void host_log(const char *p, int len);

static JSRuntime *rt;
static JSContext *ctx;
static char *out; static int out_len;
static uint8_t *buf; static size_t buf_len;
static int budget, ticks, slice_requested, tool_calls;

static void set_out(const char *s, size_t n) {
    free(out); out = malloc(n + 1); memcpy(out, s, n); out[n] = 0; out_len = (int)n;
}
static void set_out_json(JSValueConst v) {
    JSValue j = JS_JSONStringify(ctx, v, JS_UNDEFINED, JS_UNDEFINED);
    if (JS_IsException(j) || JS_IsUndefined(j)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        set_out("null", 4); return;
    }
    size_t n; const char *s = JS_ToCStringLen(ctx, &n, j);
    if (s) { set_out(s, n); JS_FreeCString(ctx, s); } else set_out("null", 4);
    JS_FreeValue(ctx, j);
}

static JSValue js_print(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    size_t n; const char *s = JS_ToCStringLen(c, &n, argv[0]);
    if (!s) return JS_EXCEPTION;
    host_log(s, (int)n); JS_FreeCString(c, s);
    return JS_UNDEFINED;
}
/* tool(name, args): park the caller; the host answers later with dq_resume */
static JSValue js_tool(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
    tool_calls++;
    JSValue g = JS_GetGlobalObject(c), call = JS_NewObject(c);
    JS_SetPropertyStr(c, call, "name", JS_DupValue(c, argv[0]));
    JS_SetPropertyStr(c, call, "args", argc > 1 ? JS_DupValue(c, argv[1]) : JS_UNDEFINED);
    JS_SetPropertyStr(c, g, "__pending", call);
    JS_FreeValue(c, g);
    return JS_SuspendCall(c);
}
static const void * const natives[] = { (const void *)js_print, (const void *)js_tool };
static const JSSnapshotHost host = { .natives = natives, .native_count = 2 };

static int on_interrupt(JSRuntime *r, void *opaque) {
    if (budget && ++ticks >= budget) { ticks = 0; slice_requested = 1; JS_RequestSuspend(r); }
    return 0;
}
static void configure(void) {
    JS_SetInterruptHandler(rt, on_interrupt, NULL);
    JS_SetMemoryLimit(rt, 64 << 20);
}

static int settle(JSValue v) {
    /* only the suspend marker means "pending": any other exception is a real error,
       even while a suspended execution exists (e.g. a bad resume value) */
    if (JS_IsException(v) && JS_IsSuspended(rt) && JS_IsSuspendException(ctx)) {
        if (slice_requested) { slice_requested = 0; set_out("{\"slice\":true}", 14); return 2; }
        /* {"name": string, "args": "<args as JSON text>"} */
        JSValue g = JS_GetGlobalObject(ctx);
        JSValue p = JS_GetPropertyStr(ctx, g, "__pending");
        JSValue args = JS_GetPropertyStr(ctx, p, "args");
        JSValue text = JS_JSONStringify(ctx, args, JS_UNDEFINED, JS_UNDEFINED);
        if (JS_IsException(text) || JS_IsUndefined(text)) { JS_FreeValue(ctx, JS_GetException(ctx)); text = JS_NewString(ctx, "null"); }
        JSValue env = JS_NewObject(ctx);
        JSValue name = JS_GetPropertyStr(ctx, p, "name");
        JS_SetPropertyStr(ctx, env, "name", JS_ToString(ctx, name));
        JS_FreeValue(ctx, name);
        JS_SetPropertyStr(ctx, env, "args", text);
        set_out_json(env);
        JS_FreeValue(ctx, env); JS_FreeValue(ctx, args); JS_FreeValue(ctx, p); JS_FreeValue(ctx, g);
        return 1;
    }
    if (JS_IsException(v)) {
        JSValue e = JS_GetException(ctx), o = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, o, "error", JS_ToString(ctx, e));
        if (JS_IsObject(e)) JS_SetPropertyStr(ctx, o, "stack", JS_GetPropertyStr(ctx, e, "stack"));
        set_out_json(o);
        JS_FreeValue(ctx, o); JS_FreeValue(ctx, e);
        return -1;
    }
    /* drain promise jobs so async programs settle too */
    JSContext *c1;
    for (;;) { int r = JS_ExecutePendingJob(rt, &c1); if (r <= 0) break; }
    set_out_json(v); JS_FreeValue(ctx, v);
    return 0;
}

EXPORT(dq_malloc) void *dq_malloc(int n) { return malloc(n); }
EXPORT(dq_free) void dq_free(void *p) { free(p); }
EXPORT(dq_out) char *dq_out(void) { return out; }
EXPORT(dq_out_len) int dq_out_len(void) { return out_len; }
EXPORT(dq_buf) uint8_t *dq_buf(void) { return buf; }
EXPORT(dq_buf_len) int dq_buf_len(void) { return (int)buf_len; }
EXPORT(dq_set_budget) void dq_set_budget(int t) { budget = t; ticks = 0; }
EXPORT(dq_tool_calls) int dq_tool_calls(void) { return tool_calls; }
EXPORT(dq_is_suspended) int dq_is_suspended(void) { return rt ? JS_IsSuspended(rt) : -1; }

static void free_buf(void) { if (buf && ctx) js_free(ctx, buf); buf = NULL; buf_len = 0; }
static void teardown(void) {
    free_buf();
    if (ctx) { JS_FreeContext(ctx); ctx = NULL; }
    if (rt) { JS_FreeRuntime(rt); rt = NULL; }
}

EXPORT(dq_init) int dq_init(void) {
    teardown();
    rt = JS_NewRuntime(); configure();
    ctx = JS_NewContextRaw(rt);
    JS_AddIntrinsicBaseObjects(ctx); JS_AddIntrinsicEval(ctx); JS_AddIntrinsicJSON(ctx);
    JS_AddIntrinsicMapSet(ctx); JS_AddIntrinsicPromise(ctx); JS_AddIntrinsicRegExp(ctx);
    JS_AddIntrinsicDate(ctx); JS_AddIntrinsicProxy(ctx); JS_AddIntrinsicTypedArrays(ctx);
    JSValue g = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, g, "print", JS_NewCFunction(ctx, js_print, "print", 1));
    JS_SetPropertyStr(ctx, g, "tool", JS_NewCFunction(ctx, js_tool, "tool", 2));
    JS_FreeValue(ctx, g);
    return 0;
}

static int write_snap(int flags) {
    free_buf();
    buf = JS_WriteSnapshot(ctx, &buf_len, &host, NULL, 0, flags);
    if (!buf) {
        JSValue e = JS_GetException(ctx), o = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, o, "error", JS_ToString(ctx, e));
        set_out_json(o); JS_FreeValue(ctx, o); JS_FreeValue(ctx, e);
        return -1;
    }
    return 0;
}

/* base: after natives are installed, before any program runs. Reproducible. */
EXPORT(dq_make_base) int dq_make_base(void) { return write_snap(JS_SNAPSHOT_BASE); }
EXPORT(dq_save) int dq_save(int delta) { return write_snap(delta ? JS_SNAPSHOT_DELTA : 0); }

EXPORT(dq_start) int dq_start(const char *src, int len, int ts) {
    char *s = malloc(len + 1); memcpy(s, src, len); s[len] = 0;
    JSValue v = JS_Eval(ctx, s, len, "<program>", JS_EVAL_TYPE_GLOBAL | (ts ? JS_EVAL_FLAG_TYPESCRIPT : 0));
    free(s);
    return settle(v);
}

EXPORT(dq_resume) int dq_resume(const char *json, int len) {
    /* JS_ParseJSON needs a NUL-terminated buffer */
    char *z = malloc(len + 1); memcpy(z, json, len); z[len] = 0;
    JSValue r = len ? JS_ParseJSON(ctx, z, len, "<result>") : JS_UNDEFINED;
    free(z);
    if (JS_IsException(r)) return settle(r);
    return settle(JS_ResumeWith(ctx, r, 0));
}

EXPORT(dq_restore) int dq_restore(const uint8_t *base, int blen, const uint8_t *d, int dlen) {
    teardown();
    rt = JS_NewRuntime();
    JSSnapshotResult res; char err[256];
    if (JS_ReadSnapshot(rt, base, blen, dlen ? d : NULL, dlen, &host, &res, err, sizeof err)) {
        char tmp[400]; int k = snprintf(tmp, sizeof tmp, "{\"error\":\"restore: %s\"}", err);
        set_out(tmp, k); JS_FreeRuntime(rt); rt = NULL; return -1;
    }
    ctx = res.contexts[0];
    for (int i = 1; i < res.context_count; i++) JS_FreeContext(res.contexts[i]);
    JS_FreeSnapshotResult(rt, &res);
    configure(); /* runtime config is not part of a snapshot */
    return 0;
}
