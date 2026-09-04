import fs from 'node:fs';
import path from 'node:path';
import { env } from './config/env.js';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  silent: 100,
};

const COLOR: Record<string, string> = {
  trace: '\x1b[90m',
  debug: '\x1b[36m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
  dim: '\x1b[2m',
};

export type LogFields = Record<string, unknown>;

/**
 * A structured log record. Every line the application emits has this shape,
 * which keeps logs greppable and machine-parseable.
 */
export interface LogRecord extends LogFields {
  time: string;
  level: LogLevel;
  msg: string;
}

function normaliseLevel(value: string): LogLevel {
  const v = value.toLowerCase() as LogLevel;
  return (LOG_LEVELS as readonly string[]).includes(v) ? v : 'info';
}

/** Turn an unknown thrown value into something safe to serialise. */
export function serialiseError(err: unknown): LogFields {
  if (err instanceof Error) {
    const out: LogFields = { name: err.name, message: err.message };
    if (err.stack) out.stack = err.stack;
    // Carry over useful custom properties (e.g. FetchError.code).
    for (const key of Object.keys(err) as (keyof typeof err)[]) {
      const value = (err as unknown as LogFields)[key as string];
      if (value !== undefined && typeof value !== 'function') out[key as string] = value;
    }
    if (err.cause !== undefined && err.cause !== null) {
      out.cause = err.cause instanceof Error ? err.cause.message : String(err.cause);
    }
    return out;
  }
  return { message: String(err) };
}

class FileSink {
  private stream: fs.WriteStream | null = null;

  constructor(private readonly filePath: string) {}

  write(line: string): void {
    try {
      if (!this.stream) {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
        this.stream.on('error', () => {
          // Never let logging take the process down.
          this.stream = null;
        });
      }
      this.stream.write(line + '\n');
    } catch {
      this.stream = null;
    }
  }
}

const fileSink = env.logFile && !env.isTest ? new FileSink(env.logFile) : null;

/** Listener hook used by the API to expose a live in-memory log tail. */
export type LogListener = (record: LogRecord) => void;
const listeners = new Set<LogListener>();

export function onLog(listener: LogListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function formatPretty(record: LogRecord): string {
  const { time, level, msg, ...rest } = record;
  const colour = COLOR[level] ?? '';
  const stamp = time.slice(11, 23);
  const head = `${COLOR.dim}${stamp}${COLOR.reset} ${colour}${level.toUpperCase().padEnd(5)}${COLOR.reset} ${msg}`;
  const keys = Object.keys(rest);
  if (keys.length === 0) return head;
  const tail = keys
    .map((k) => {
      const v = rest[k];
      if (k === 'stack') return '';
      const printed = typeof v === 'string' ? v : JSON.stringify(v);
      return `${COLOR.dim}${k}=${COLOR.reset}${printed}`;
    })
    .filter(Boolean)
    .join(' ');
  const stack = typeof rest.stack === 'string' ? `\n${COLOR.dim}${rest.stack}${COLOR.reset}` : '';
  return `${head} ${COLOR.dim}|${COLOR.reset} ${tail}${stack}`;
}

/**
 * The active level, held in one shared box.
 *
 * Child loggers share this with the root rather than copying it, so changing
 * the level at runtime takes effect everywhere instead of only affecting
 * loggers created afterwards.
 */
interface LevelState {
  level: LogLevel;
}

const rootLevel: LevelState = { level: normaliseLevel(env.logLevel) };

export class Logger {
  constructor(
    private readonly bindings: LogFields = {},
    private readonly levelState: LevelState = rootLevel,
  ) {}

  /** Create a sub-logger that always includes the given fields. */
  child(bindings: LogFields): Logger {
    return new Logger({ ...this.bindings, ...bindings }, this.levelState);
  }

  setLevel(level: LogLevel): void {
    this.levelState.level = normaliseLevel(level);
  }

  getLevel(): LogLevel {
    return this.levelState.level;
  }

  isEnabled(level: LogLevel): boolean {
    return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[this.levelState.level];
  }

  trace(msg: string, fields?: LogFields): void {
    this.emit('trace', msg, fields);
  }

  debug(msg: string, fields?: LogFields): void {
    this.emit('debug', msg, fields);
  }

  info(msg: string, fields?: LogFields): void {
    this.emit('info', msg, fields);
  }

  warn(msg: string, fields?: LogFields): void {
    this.emit('warn', msg, fields);
  }

  error(msg: string, fields?: LogFields): void {
    this.emit('error', msg, fields);
  }

  private emit(level: LogLevel, msg: string, fields?: LogFields): void {
    if (!this.isEnabled(level)) return;

    const record: LogRecord = {
      time: new Date().toISOString(),
      level,
      msg,
      ...this.bindings,
      ...(fields ?? {}),
    };

    const json = JSON.stringify(record);

    if (env.logFormat === 'json') {
      process.stdout.write(json + '\n');
    } else {
      const line = formatPretty(record);
      if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
      else process.stdout.write(line + '\n');
    }

    fileSink?.write(json);

    for (const listener of listeners) {
      try {
        listener(record);
      } catch {
        // A broken listener must not break logging.
      }
    }
  }
}

/** Application-wide root logger. */
export const logger = new Logger();

