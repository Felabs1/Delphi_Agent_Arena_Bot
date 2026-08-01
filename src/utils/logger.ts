/**
 * Structured logging.
 *
 * Two audiences: a human reading a terminal during development, and a log
 * aggregator reading JSON from a cron job. `LOG_FORMAT=json` switches between
 * them. Every run gets a `runId` so a single cron tick can be reconstructed.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

export function createLogger(
  level: LogLevel = "info",
  context: Record<string, unknown> = {},
  json = process.env.LOG_FORMAT === "json",
): Logger {
  const emit = (
    lvl: LogLevel,
    message: string,
    fields?: Record<string, unknown>,
  ): void => {
    if (ORDER[lvl] < ORDER[level]) return;
    const payload = { ...context, ...fields };

    if (json) {
      // bigints are everywhere in this codebase and JSON.stringify throws on them.
      process.stdout.write(
        JSON.stringify(
          { ts: new Date().toISOString(), level: lvl, message, ...payload },
          (_k, v) => (typeof v === "bigint" ? v.toString() : v),
        ) + "\n",
      );
      return;
    }

    const tail = Object.keys(payload).length
      ? " " +
        Object.entries(payload)
          .map(([k, v]) => `${k}=${format(v)}`)
          .join(" ")
      : "";
    const line = `${TAG[lvl]} ${message}${tail}`;
    if (lvl === "error" || lvl === "warn") console.error(line);
    else console.log(line);
  };

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (extra) => createLogger(level, { ...context, ...extra }, json),
  };
}

const TAG: Record<LogLevel, string> = {
  debug: "·",
  info: "→",
  warn: "!",
  error: "✗",
};

function format(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(4);
  if (typeof v === "string") return v.includes(" ") ? JSON.stringify(v) : v;
  if (v instanceof Date) return v.toISOString();
  if (v === null || v === undefined) return "-";
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
}
