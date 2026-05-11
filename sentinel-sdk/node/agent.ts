import json
import time
import uuid
import datetime
import sys
import os
import functools
import urllib.request
import urllib.error
import base64

class LogLayer:
    PRESENTATION = 'presentation'
    API_GATEWAY = 'api_gateway'
    BUSINESS_LOGIC = 'business_logic'
    DATA_ACCESS = 'data_access'
    SERVICE = 'service'
    SECURITY = 'security'
    OBSERVABILITY = 'observability'
    INFRASTRUCTURE = 'infrastructure'

class LogLevel:
    INFO = 'INFO'
    WARN = 'WARN'
    ERROR = 'ERROR'
    DEBUG = 'DEBUG'
    FATAL = 'FATAL'

class LogRecord:
    def __init__(
        self,
        message,
        layer=LogLayer.BUSINESS_LOGIC,
        level=LogLevel.INFO,
        service='unknown-python-service',
        context=None
    ):
        self.message = message
        self.layer = layer
        self.level = level
        self.timestamp = datetime.datetime.now(
            datetime.timezone.utc
        ).isoformat()

        self.record_id = str(uuid.uuid4())
        self.trace_id = 'untracked'
        self.span_id = 'untracked'
        self.service = service
        self.env = os.getenv('ENV', 'development')
        self.context = context or {}

    def to_dict(self):
        return self.__dict__

    def __str__(self):
        color = "\033[92m"

        if self.level == LogLevel.ERROR:
            color = "\033[91m"

        elif self.level == LogLevel.WARN:
            color = "\033[93m"

        reset = "\033[0m"

        return (
            f"{color}[{self.timestamp}] "
            f"[{self.layer.upper()}] "
            f"[{self.level}] "
            f"{self.message}{reset}"
        )

class SentinelPython:
    def __init__(self, service_name='python-service'):
        self.service_name = service_name

        self.clickhouse_host = os.getenv('CLICKHOUSE_HOST')
        self.clickhouse_database = os.getenv('CLICKHOUSE_DATABASE')
        self.clickhouse_table = os.getenv('CLICKHOUSE_TABLE', 'logs')

        self.clickhouse_user = os.getenv('CLICKHOUSE_USER')
        self.clickhouse_password = os.getenv('CLICKHOUSE_PASSWORD', '')

        self.auth_header = None

        if self.clickhouse_user:
            credentials = (
                f"{self.clickhouse_user}:"
                f"{self.clickhouse_password}"
            )

            encoded = base64.b64encode(
                credentials.encode()
            ).decode()

            self.auth_header = f"Basic {encoded}"

        self.init_clickhouse()

    def hook(self):
        self._patch_builtins()

        record = LogRecord(
            "Sentinel Python Agent hooked successfully",
            layer=LogLayer.INFRASTRUCTURE,
            service=self.service_name
        )

        self.persist(record)

        print(f"[SENTINEL] {record}")

    def clickhouse_enabled(self):
        return (
            self.clickhouse_host and
            self.clickhouse_database and
            self.clickhouse_table
        )

    def execute_query(self, query):
        if not self.clickhouse_enabled():
            return

        try:
            url = (
                f"{self.clickhouse_host}"
                f"/?query={urllib.parse.quote(query)}"
            )

            headers = {}

            if self.auth_header:
                headers['Authorization'] = self.auth_header

            req = urllib.request.Request(
                url,
                method='POST',
                headers=headers
            )

            with urllib.request.urlopen(req) as response:
                response.read()

        except Exception as e:
            sys.__stdout__.write(
                f"[SENTINEL] ClickHouse query error: {e}\n"
            )

    def init_clickhouse(self):
        if not self.clickhouse_enabled():
            return

        try:
            create_db_query = f"""
            CREATE DATABASE IF NOT EXISTS {self.clickhouse_database}
            """

            self.execute_query(create_db_query)

            create_table_query = f"""
            CREATE TABLE IF NOT EXISTS
            {self.clickhouse_database}.{self.clickhouse_table}
            (
                timestamp String,
                record_id String,
                trace_id String,
                span_id String,
                service String,
                env String,
                layer String,
                level String,
                message String,
                context String
            )
            ENGINE = MergeTree()
            ORDER BY (timestamp, service)
            """

            self.execute_query(create_table_query)

            sys.__stdout__.write(
                "[SENTINEL] ClickHouse initialized successfully\n"
            )

        except Exception as e:
            sys.__stdout__.write(
                f"[SENTINEL] ClickHouse init failed: {e}\n"
            )

    def send_to_clickhouse(self, record):
        if not self.clickhouse_enabled():
            return

        try:
            query = f"""
            INSERT INTO
            {self.clickhouse_database}.{self.clickhouse_table}
            FORMAT JSONEachRow
            """

            url = (
                f"{self.clickhouse_host}"
                f"/?query={urllib.parse.quote(query)}"
            )

            payload = {
                'timestamp': record.timestamp,
                'record_id': record.record_id,
                'trace_id': record.trace_id,
                'span_id': record.span_id,
                'service': record.service,
                'env': record.env,
                'layer': record.layer,
                'level': record.level,
                'message': record.message,
                'context': json.dumps(record.context)
            }

            body = json.dumps(payload).encode('utf-8')

            headers = {
                'Content-Type': 'application/json'
            }

            if self.auth_header:
                headers['Authorization'] = self.auth_header

            req = urllib.request.Request(
                url,
                data=body,
                headers=headers,
                method='POST'
            )

            with urllib.request.urlopen(req) as response:
                response.read()

        except Exception as e:
            sys.__stdout__.write(
                f"[SENTINEL] ClickHouse ingest failed: {e}\n"
            )

    def persist(self, record):
        self.send_to_clickhouse(record)

    def _patch_builtins(self):
        original_print = print
        self_ref = self

        def sentinel_print(*args, **kwargs):
            msg = " ".join(map(str, args))

            if "[SENTINEL]" in msg:
                original_print(*args, **kwargs)
                return

            record = LogRecord(
                msg,
                service=self_ref.service_name
            )

            self_ref.persist(record)

            original_print(f"[SENTINEL] {record}")

        import builtins
        builtins.print = sentinel_print

    def track_function(
        self,
        layer=LogLayer.BUSINESS_LOGIC
    ):
        def decorator(func):

            @functools.wraps(func)
            def wrapper(*args, **kwargs):

                start_time = time.time()

                record = LogRecord(
                    f"Calling {func.__name__}",
                    layer=layer,
                    service=self.service_name
                )

                self.persist(record)

                print(f"[SENTINEL] {record}")

                try:
                    result = func(*args, **kwargs)

                    duration = (
                        (time.time() - start_time) * 1000
                    )

                    success_record = LogRecord(
                        f"Finished {func.__name__} "
                        f"in {duration:.2f}ms",

                        layer=layer,
                        service=self.service_name
                    )

                    self.persist(success_record)

                    print(f"[SENTINEL] {success_record}")

                    return result

                except Exception as e:

                    err_record = LogRecord(
                        f"Error in {func.__name__}: {str(e)}",

                        layer=layer,
                        level=LogLevel.ERROR,
                        service=self.service_name
                    )

                    self.persist(err_record)

                    print(f"[SENTINEL] {err_record}")

                    raise

            return wrapper

        return decorator

def init_sentinel(name='python-service'):
    s = SentinelPython(name)

    s.hook()

    return s
