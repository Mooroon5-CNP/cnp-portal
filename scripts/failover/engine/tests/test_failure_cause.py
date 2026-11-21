import io
import json
from pathlib import Path
import socket
import ssl
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import automation as a
import bootstrap


class SqlError(Exception):
    def __init__(self, sqlstate):
        super().__init__("FATAL: password authentication failed for user cnp_runtime password=hunter2")
        self.sqlstate = sqlstate


class OperationalError(Exception):
    pass


class ConnectionTimeout(OperationalError):
    pass


class ClientError(Exception):
    def __init__(self, code):
        super().__init__(f"arn:aws:iam::123456789012:user/x is not authorized ({code})")
        self.response = {"Error": {"Code": code}}


class FailureCause(unittest.TestCase):
    def test_classes_sqlstates_and_aws_codes_map_to_closed_codes(self):
        cases = {
            socket.timeout(): "CONNECT_TIMEOUT", TimeoutError(): "CONNECT_TIMEOUT", ConnectionTimeout(): "CONNECT_TIMEOUT",
            ConnectionRefusedError(): "CONNECT_REFUSED", OperationalError(): "CONNECT_REFUSED",
            ssl.SSLCertVerificationError(): "TLS", SqlError("28P01"): "SQL_AUTH", SqlError("57P03"): "SQL_UNAVAILABLE",
            SqlError("53300"): "SQL_UNAVAILABLE", SqlError("42501"): "SQL_PERMISSION", SqlError("23505"): "SQL_ERROR",
            ClientError("AccessDeniedException"): "AWS_ACCESS", ClientError("ThrottlingException"): "AWS_THROTTLED",
            ClientError("ResourceNotFoundException"): "AWS_ERROR", ValueError("Clôture non prouvée"): "PROOF",
            a.Blocked("BLOCKED_SQL_STATE"): "PROOF", RuntimeError("?"): "UNKNOWN",
        }
        for error, expected in cases.items():
            self.assertEqual(a.failure_cause(error), expected, type(error).__name__)
            self.assertIn(expected, a.FAILURE_CAUSES)

    def test_chained_cause_is_followed(self):
        try:
            try:
                raise socket.timeout()
            except socket.timeout as inner:
                raise OperationalError("connection failed") from inner
        except OperationalError as error:
            self.assertEqual(a.failure_cause(error), "CONNECT_TIMEOUT")

    def test_bootstrap_prints_only_the_code_and_its_label(self):
        out, err = io.StringIO(), io.StringIO()
        with tempfile.NamedTemporaryFile("w", suffix=".json") as config:
            config.write("{}"); config.flush()
            with patch.object(bootstrap, "validate", side_effect=SqlError("28P01")), redirect_stdout(out), redirect_stderr(err):
                code = bootstrap.main(["verify-replication", "--config", config.name, "--execute"])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(out.getvalue()), {"operation": "verify-replication", "failed": True, "cause": "SQL_AUTH"})
        self.assertIn(a.FAILURE_CAUSES["SQL_AUTH"], err.getvalue())
        self.assertNotIn("hunter2", out.getvalue() + err.getvalue())


if __name__ == "__main__":
    unittest.main()
