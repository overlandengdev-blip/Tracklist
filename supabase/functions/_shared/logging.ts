/**
 * Structured JSON logging for edge functions.
 * Outputs to stdout where Supabase captures it.
 */

interface LogContext {
  function_name: string;
  clip_id?: string;
  user_id?: string;
  [key: string]: unknown;
}

type LogLevel = "info" | "warn" | "error" | "debug";

function log(level: LogLevel, message: string, context: LogContext): void {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...context,
  };
  if (level === "error") {
    console.error(JSON.stringify(entry));
  } else if (level === "warn") {
    console.warn(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

export function logInfo(message: string, context: LogContext): void {
  log("info", message, context);
}

export function logWarn(message: string, context: LogContext): void {
  log("warn", message, context);
}

export function logError(message: string, context: LogContext): void {
  log("error", message, context);
}

export function logDebug(message: string, context: LogContext): void {
  log("debug", message, context);
}

/**
 * Create a scoped logger for a specific function invocation.
 */
export function createLogger(functionName: string, userId?: string) {
  const base: LogContext = { function_name: functionName };
  if (userId) base.user_id = userId;

  return {
    info: (msg: string, extra?: Record<string, unknown>) =>
      logInfo(msg, { ...base, ...extra }),
    warn: (msg: string, extra?: Record<string, unknown>) =>
      logWarn(msg, { ...base, ...extra }),
    error: (msg: string, extra?: Record<string, unknown>) =>
      logError(msg, { ...base, ...extra }),
    debug: (msg: string, extra?: Record<string, unknown>) =>
      logDebug(msg, { ...base, ...extra }),
    /** Return a child logger with additional context (e.g., clip_id) */
    child: (extra: Record<string, unknown>) =>
      createLogger(functionName, userId),
    /** Time a block and log duration */
    async timed<T>(
      label: string,
      fn: () => Promise<T>,
      extra?: Record<string, unknown>,
    ): Promise<T> {
      const start = Date.now();
      try {
        const result = await fn();
        logInfo(`${label} completed`, {
          ...base,
          ...extra,
          duration_ms: Date.now() - start,
        });
        return result;
      } catch (err) {
        logError(`${label} failed`, {
          ...base,
          ...extra,
          duration_ms: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  };
}
