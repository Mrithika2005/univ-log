import { LogLayer, LogLevel, LogRecord } from '../core/types.ts';

export class SentinelBrowser {
  private serviceName: string;
  private collectorUrl: string;

  constructor(
    serviceName: string = 'browser-app',
    collectorUrl: string = 'http://localhost:8000/logs'
  ) {
    this.serviceName = serviceName;
    this.collectorUrl = collectorUrl;
  }

  hook() {
    this.patchFetch();
    this.hookEvents();
    this.hookErrors();
    this.monitorVitals();

    const record = new LogRecord({
      message: 'Sentinel Browser Agent hooked successfully',
      layer: LogLayer.PRESENTATION,
      level: LogLevel.INFO,
      service: this.serviceName,
    });

    this.log(record);
  }

  private async sendToCollector(record: LogRecord) {
    try {
      await fetch(this.collectorUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(record),
      });
    } catch (err) {
      console.error('[SENTINEL] Failed to send log:', err);
    }
  }

  private log(record: LogRecord) {
    console.log(record.toString());
    this.sendToCollector(record);
  }

  private patchFetch() {
    const originalFetch = window.fetch.bind(window);
    const self = this;

    const wrappedFetch = async (...args: any[]) => {
      const [resource, config] = args;
      const startTime = performance.now();

      const record = new LogRecord({
        message: `Fetch Request: ${resource}`,
        layer: LogLayer.SERVICE,
        level: LogLevel.INFO,
        service: self.serviceName,
        context: {
          resource,
          method: config?.method || 'GET',
        },
      });

      self.log(record);

      try {
        const response = await originalFetch(...args);
        const duration = performance.now() - startTime;

        const resRecord = new LogRecord({
          message: `Fetch Completed: ${resource} -> ${response.status}`,
          layer: LogLayer.SERVICE,
          level: response.ok ? LogLevel.INFO : LogLevel.ERROR,
          service: self.serviceName,
          context: {
            status: response.status,
            durationMs: duration,
          },
        });

        self.log(resRecord);

        return response;
      } catch (error) {
        const errRecord = new LogRecord({
          message: `Fetch Failed: ${resource}`,
          layer: LogLayer.SERVICE,
          level: LogLevel.ERROR,
          service: self.serviceName,
          context: {
            error: String(error),
          },
        });

        self.log(errRecord);

        throw error;
      }
    };

    try {
      Object.defineProperty(window, 'fetch', {
        value: wrappedFetch,
        configurable: true,
        writable: true,
        enumerable: true,
      });
    } catch (e) {
      (window as any).fetch = wrappedFetch;
    }
  }

  private hookEvents() {
    const self = this;

    ['click', 'submit', 'scroll'].forEach((eventType) => {
      window.addEventListener(
        eventType,
        (e) => {
          const target = e.target as HTMLElement;

          const record = new LogRecord({
            message: `User Interaction: ${eventType} on ${
              target.tagName || 'window'
            }`,
            layer: LogLayer.PRESENTATION,
            level: LogLevel.INFO,
            service: self.serviceName,
            context: {
              eventType,
              id: target.id,
              className: target.className,
              text: target.innerText?.substring(0, 50),
            },
          });

          self.log(record);
        },
        { capture: true, passive: true }
      );
    });
  }

  private hookErrors() {
    const self = this;

    window.onerror = (message, source, lineno, colno, error) => {
      const record = new LogRecord({
        message: `Frontend Error: ${message}`,
        layer: LogLayer.SECURITY,
        level: LogLevel.FATAL,
        service: self.serviceName,
        context: {
          source,
          lineno,
          colno,
          stack: error?.stack,
        },
      });

      self.log(record);
    };

    window.onunhandledrejection = (event) => {
      const record = new LogRecord({
        message: `Unhandled Promise Rejection: ${event.reason}`,
        layer: LogLayer.OBSERVABILITY,
        level: LogLevel.ERROR,
        service: self.serviceName,
        context: {
          reason: event.reason,
        },
      });

      self.log(record);
    };
  }

  private monitorVitals() {
    if ('PerformanceObserver' in window) {
      const observer = new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => {
          const record = new LogRecord({
            message: `Web Vital: ${entry.name}`,
            layer: LogLayer.PRESENTATION,
            level: LogLevel.INFO,
            service: this.serviceName,
            context: {
              value: (entry as any).value || (entry as any).startTime,
              entryType: entry.entryType,
            },
          });

          this.log(record);
        });
      });

      observer.observe({
        entryTypes: [
          'paint',
          'largest-contentful-paint',
          'layout-shift',
          'navigation',
        ],
      });
    }
  }
}

export const initBrowserSentinel = (
  name?: string,
  collectorUrl?: string
) => {
  const sentinel = new SentinelBrowser(name, collectorUrl);

  sentinel.hook();

  return sentinel;
};
