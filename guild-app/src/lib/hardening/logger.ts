type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  requestId?: string;
  route?: string;
  duration?: number;
  [key: string]: unknown;
}

function createLogEntry(
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>,
): LogEntry {
  return {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...context,
  };
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  const entry = createLogEntry(level, message, context);

  if (isProduction()) {
    let output: string;
    try {
      output = JSON.stringify(entry);
    } catch {
      try {
        output = JSON.stringify({ ...entry, _serializationError: true }, (key, v) => {
          if (key === "") return v;
          if (typeof v === "bigint") return v.toString();
          if (typeof v === "function" || typeof v === "symbol") return String(v);
          if (typeof v === "object" && v !== null) return "[Object]";
          return v;
        });
      } catch {
        output = `{"level":"${level}","message":"${message}","_serializationError":true}`;
      }
    }
    switch (level) {
      case "error":
        console.error(output);
        break;
      case "warn":
        console.warn(output);
        break;
      default:
        console.log(output);
    }
  } else {
    const prefix = `[${level.toUpperCase()}]`;
    const ctx = context ? ` ${JSON.stringify(context)}` : "";
    const msg = `${prefix} ${message}${ctx}`;
    switch (level) {
      case "error":
        console.error(msg);
        break;
      case "warn":
        console.warn(msg);
        break;
      default:
        console.log(msg);
    }
  }
}

export const logger = {
  info: (message: string, context?: Record<string, unknown>): void => {
    log("info", message, context);
  },
  warn: (message: string, context?: Record<string, unknown>): void => {
    log("warn", message, context);
  },
  error: (message: string, context?: Record<string, unknown>): void => {
    log("error", message, context);
  },
  debug: (message: string, context?: Record<string, unknown>): void => {
    if (!isProduction()) {
      log("debug", message, context);
    }
  },
};
