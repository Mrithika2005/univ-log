import { LogLayer, LogLevel, LogRecord } from '../core/types.ts';

export class SentinelBrowser {
  private serviceName: string;

  constructor(serviceName: string = 'browser-app') {
    this.serviceName = serviceName;
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
    console.log(record.toString());
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
        context: { resource, method: config?.method || 'GET' }
      });
      console.log(record.toString());

      try {
        const response = await originalFetch(...args);
        const duration = performance.now() - startTime;
        
        const resRecord = new LogRecord({
          message: `Fetch Completed: ${resource} -> ${response.status}`,
          layer: LogLayer.SERVICE,
          level: response.ok ? LogLevel.INFO : LogLevel.ERROR,
          service: self.serviceName,
          context: { status: response.status, durationMs: duration }
        });
        console.log(resRecord.toString());
        
        return response;
      } catch (error) {
        const errRecord = new LogRecord({
          message: `Fetch Failed: ${resource}`,
          layer: LogLayer.SERVICE,
          level: LogLevel.ERROR,
          service: self.serviceName,
          context: { error: String(error) }
        });
        console.log(errRecord.toString());
        throw error;
      }
    };

    try {
      Object.defineProperty(window, 'fetch', {
        value: wrappedFetch,
        configurable: true,
        writable: true,
        enumerable: true
      });
    } catch (e) {
      // Fallback for very restrictive environments
      (window as any).fetch = wrappedFetch;
    }
  }

  private hookEvents() {
    const self = this;
    ['click', 'submit', 'scroll'].forEach(eventType => {
      window.addEventListener(eventType, (e) => {
        const target = e.target as HTMLElement;
        const record = new LogRecord({
          message: `User Interaction: ${eventType} on ${target.tagName || 'window'}`,
          layer: LogLayer.PRESENTATION,
          level: LogLevel.INFO,
          service: self.serviceName,
          context: {
            eventType,
            id: target.id,
            className: target.className,
            text: target.innerText?.substring(0, 50),
          }
        });
        console.log(record.toString());
      }, { capture: true, passive: true });
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
        context: { source, lineno, colno, stack: error?.stack }
      });
      console.log(record.toString());
    };

    window.onunhandledrejection = (event) => {
      const record = new LogRecord({
        message: `Unhandled Promise Rejection: ${event.reason}`,
        layer: LogLayer.OBSERVABILITY,
        level: LogLevel.ERROR,
        service: self.serviceName,
        context: { reason: event.reason }
      });
      console.log(record.toString());
    };
  }

  private monitorVitals() {
    // Simple Web Vitals monitoring
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
            }
          });
          console.log(record.toString());
        });
      });
      observer.observe({ entryTypes: ['paint', 'largest-contentful-paint', 'layout-shift', 'navigation'] });
    }
  }
}

export const initBrowserSentinel = (name?: string) => {
  const sentinel = new SentinelBrowser(name);
  sentinel.hook();
  return sentinel;
};
