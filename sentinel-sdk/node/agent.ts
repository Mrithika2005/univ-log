import { LogLayer, LogLevel, LogRecord } from '../core/types.ts';
import http from 'http';
import fs from 'fs';

export class SentinelNode {
  private serviceName: string;
  private clickhouseHost?: string;
  private clickhouseDatabase?: string;
  private clickhouseTable: string;
  private clickhouseAuthHeader?: string;

  constructor(serviceName: string = 'node-service') {
    this.serviceName = serviceName;
    this.clickhouseHost = process.env.CLICKHOUSE_HOST;
    this.clickhouseDatabase = process.env.CLICKHOUSE_DATABASE;
    this.clickhouseTable = process.env.CLICKHOUSE_TABLE || 'sentinel_logs';

    const user = process.env.CLICKHOUSE_USER;
    const password = process.env.CLICKHOUSE_PASSWORD;
    if (user && password) {
      this.clickhouseAuthHeader = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
    }

    void this.initClickhouse();
  }

  /**
   * Automatically hook into Node.js modules
   */
  hook() {
    this.patchHttp();
    this.patchConsole();
    this.patchFS();
    
    const record = new LogRecord({
      message: 'Sentinel Node Agent hooked successfully',
      layer: LogLayer.INFRASTRUCTURE,
      level: LogLevel.INFO,
      service: this.serviceName,
    });
    console.log(record.toString());
  }

  private clickhouseEnabled(): boolean {
    return Boolean(this.clickhouseHost && this.clickhouseDatabase);
  }

  private async initClickhouse() {
    if (!this.clickhouseEnabled()) {
      return;
    }

    try {
      const query = `CREATE TABLE IF NOT EXISTS ${this.clickhouseDatabase}.${this.clickhouseTable} (
        timestamp DateTime64(3, 'UTC'),
        record_id String,
        trace_id String,
        span_id String,
        service String,
        env String,
        layer String,
        level String,
        message String,
        context String
      ) ENGINE = MergeTree() ORDER BY (timestamp, service)`;

      const url = `${this.clickhouseHost}/?query=${encodeURIComponent(query)}`;
      const headers: Record<string, string> = {};
      if (this.clickhouseAuthHeader) {
        headers.Authorization = this.clickhouseAuthHeader;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
      });

      if (!response.ok) {
        console.error(`[SENTINEL] ClickHouse init failed: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      console.error('[SENTINEL] ClickHouse init error', error);
    }
  }

  private async sendToClickhouse(record: LogRecord) {
    if (!this.clickhouseEnabled()) {
      return;
    }

    try {
      const query = `INSERT INTO ${this.clickhouseDatabase}.${this.clickhouseTable} FORMAT JSONEachRow`;
      const url = `${this.clickhouseHost}/?query=${encodeURIComponent(query)}`;
      const body = JSON.stringify({
        ...record.to_dict(),
        context: JSON.stringify(record.context),
      });

      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (this.clickhouseAuthHeader) {
        headers.Authorization = this.clickhouseAuthHeader;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
      });

      if (!response.ok) {
        console.error(`[SENTINEL] ClickHouse ingest failed: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      console.error('[SENTINEL] ClickHouse ingest error', error);
    }
  }

  private persist(record: LogRecord) {
    void this.sendToClickhouse(record);
  }

  private patchHttp() {
    const originalCreateServer = http.createServer;
    const self = this;
    const originalConsoleLog = console.log.bind(console);

    // @ts-ignore
    http.createServer = function(requestListener?: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
      const wrappedListener = (req: http.IncomingMessage, res: http.ServerResponse) => {
        const startTime = Date.now();
        
        // Log Gateway: Request Incoming
        const reqRecord = new LogRecord({
          message: `Inbound Request: ${req.method} ${req.url}`,
          layer: LogLayer.API_GATEWAY,
          level: LogLevel.INFO,
          service: self.serviceName,
          context: {
            headers: req.headers,
            method: req.method,
            url: req.url,
            remoteAddress: req.socket.remoteAddress,
          }
        });
        void self.persist(reqRecord);
        originalConsoleLog(`[SENTINEL] ${reqRecord.toString()}`);

        res.on('finish', () => {
          const duration = Date.now() - startTime;
          const statusRecord = new LogRecord({
            message: `Request Completed: ${req.method} ${req.url} -> ${res.statusCode}`,
            layer: LogLayer.API_GATEWAY,
            level: res.statusCode >= 400 ? LogLevel.ERROR : LogLevel.INFO,
            service: self.serviceName,
            context: {
              status: res.statusCode,
              durationMs: duration,
              userAgent: req.headers['user-agent'],
            }
          });
          void self.persist(statusRecord);
          originalConsoleLog(`[SENTINEL] ${statusRecord.toString()}`);
        });

        if (requestListener) return requestListener(req, res);
      };

      return originalCreateServer(wrappedListener);
    };
  }

  private patchConsole() {
    const self = this;
    const wrapConsoleMethod = (methodName: keyof Console, level: LogLevel) => {
      const originalMethod = (console as any)[methodName].bind(console);

      (console as any)[methodName] = (...args: any[]) => {
        if (args[0] && typeof args[0] === 'string' && args[0].includes('[SENTINEL]')) {
          return originalMethod(...args);
        }

        const record = new LogRecord({
          message: args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '),
          layer: LogLayer.BUSINESS_LOGIC,
          level,
          service: self.serviceName,
        });

        void self.persist(record);
        return originalMethod(`[SENTINEL] ${record.toString()}`);
      };
    };

    wrapConsoleMethod('log', LogLevel.INFO);
    wrapConsoleMethod('info', LogLevel.INFO);
    wrapConsoleMethod('warn', LogLevel.WARN);
    wrapConsoleMethod('error', LogLevel.ERROR);
  }

  private patchFS() {
    const originalReadFile = fs.readFile;
    const self = this;
    const originalConsoleLog = console.log.bind(console);

    // @ts-ignore
    fs.readFile = function(path: any, options: any, callback?: any) {
      const record = new LogRecord({
        message: `Reading file: ${path}`,
        layer: LogLayer.DATA_ACCESS,
        level: LogLevel.DEBUG,
        service: self.serviceName,
        context: { path }
      });
      void self.persist(record);
      originalConsoleLog(`[SENTINEL] ${record.toString()}`);
      
      return originalReadFile.apply(this, arguments as any);
    };
  }
}

// Auto-init helper
export const initSentinel = (name?: string) => {
  const sentinel = new SentinelNode(name);
  sentinel.hook();
  return sentinel;
};
