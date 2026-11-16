"""Contrats du worker : aucun appel cloud, aucune donnée applicative modifiée."""
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import automation as a


def profile():
    return {"app": "app4-pixelcam", "profile": 'postgres:{"database":"pixelcalm"}', "hostname": "app4-pixelcam.apps.mooroon5.fr",
        "gcp_lb_ip": "34.160.1.1", "alarm_name": "cnp-failover-app4-pixelcam",
        "health_check_id": "12345678-1234-1234-1234-123456789abc",
        "routing_latch_id": "12345678-1234-1234-1234-123456789abd",
        "primary_health_check_id": "12345678-1234-1234-1234-123456789abe",
        "source": {"host": "10.189.0.3", "ca_pem": "TEST-CA",
            "secret_arn": "arn:aws:secretsmanager:eu-west-3:626278345026:secret:cnp/failover/app4-pixelcam/source-AbCd12"},
        "target": {"host": "app4-pixelcam-prod-db.abcdef.eu-west-3.rds.amazonaws.com", "ca_pem": "TEST-CA",
            "secret_arn": "arn:aws:secretsmanager:eu-west-3:626278345026:secret:rds!db-test-AbCd12"}}


class MemoryStore:
    def __init__(self):
        self.active, self.paused, self.busy = False, False, False
        self.transitions = []
        self.released = False
        self.fence = None
        self.evidence = {"observed_at": 1000, "last_message_at": 990, "replayed_lsn": "0/AB"}

    def acquire(self, app, owner):
        return not self.paused and not self.busy

    def control(self, name):
        return {"state": "AWS_ACTIVE" if self.active else "DISABLED", "source_fence": self.fence}

    def checkpoint(self, app, owner):
        if self.paused:
            raise a.Blocked("PAUSED_OR_LEASE_LOST")

    def transition(self, app, owner, state, field="state"):
        self.checkpoint(app, owner)
        self.transitions.append(state)
        if field == "source_fence":
            self.fence = state
        elif state == "AWS_ACTIVE":
            self.active = True

    def remember_replication(self, app, owner, observation):
        pass

    def replication_evidence(self, app):
        a.require(bool(self.evidence), "BLOCKED_UNKNOWN_OR_STALE_REPLICATION")
        return dict(self.evidence)

    def release(self, app, owner):
        self.released = True


class FakeSQL:
    def __init__(self):
        self.saved, self.source_available, self.ready = None, True, True
        self.connected, self.promotions = [], 0
        self.crash_after_commit = False
        self.on_promote = lambda: None
        self.fences = 0

    @contextmanager
    def connection(self, app, side):
        self.connected.append(side)
        if side == "source" and not self.source_available:
            raise OSError("postgresql://a-password-that-must-not-appear")
        yield side

    def saved_state(self, target, profile):
        return self.saved

    def standby_ready(self, target, profile):
        a.require(self.ready, "BLOCKED_REPLICATION")

    def observation(self, target, profile):
        return {"enabled": True, "tables_ready": True, "replayed_lsn": "0/AB", "last_message_at": 990}

    def fence_returned_source(self, source):
        self.fences += 1

    def promote_outage(self, target, app, evidence, checkpoint, on_stage):
        self.on_promote()
        checkpoint()
        self.promotions += 1
        self.saved = "AWS_ACTIVE"
        if self.crash_after_commit:
            raise RuntimeError("secret-SQL-error")
        return {"state": "AWS_ACTIVE"}


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.store, self.sql = MemoryStore(), FakeSQL()
        self.signals = Mock()
        self.signals.outage_confirmed.return_value = True
        self.signals.source_available.return_value = False
        self.routing = Mock()
        self.worker = a.Worker(self.store, self.signals, self.sql, self.routing)
        self.app = profile()

    def test_paused_or_concurrent_worker_does_not_even_connect(self):
        for field in ("paused", "busy"):
            setattr(self.store, field, True)
            self.assertEqual(self.worker.run(self.app), "PAUSED_UNCONFIGURED_OR_BUSY")
            self.assertEqual(self.sql.connected, [])
            setattr(self.store, field, False)

    def test_short_or_single_signal_failure_cannot_fence_gcp(self):
        self.signals.outage_confirmed.return_value = False
        self.assertEqual(self.worker.run(self.app), "WAIT_SIGNALS")
        self.assertEqual(self.sql.connected, ["target"])
        self.assertEqual(self.sql.promotions, 0)

    def test_target_must_be_replicating_before_source_is_closed(self):
        self.sql.ready = False
        self.assertEqual(self.worker.run(self.app), "BLOCKED_REPLICATION")
        self.assertNotIn("source", self.sql.connected)

    def test_recovered_public_endpoint_cancels_promotion_before_sql_fencing(self):
        self.signals.outage_confirmed.side_effect = [True, False]
        self.assertEqual(self.worker.run(self.app), "WAIT_SIGNALS")
        self.assertEqual(self.sql.promotions, 0)

    def test_total_gcp_outage_promotes_without_connecting_to_source_or_logging_secrets(self):
        self.sql.source_available = False
        with patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(self.worker.run(self.app), "AWS_ACTIVE")
        self.assertNotIn("password", output.getvalue())
        self.assertEqual(self.sql.promotions, 1)
        self.assertNotIn("source", self.sql.connected)
        self.assertEqual(self.store.fence, "GCP_FENCE_PENDING")
        self.assertTrue(self.store.released)

    def test_success_and_duplicate_event_promote_only_once(self):
        self.assertEqual(self.worker.run(self.app), "AWS_ACTIVE")
        self.assertEqual(self.worker.run(self.app), "AWS_ACTIVE")
        self.assertEqual(self.sql.promotions, 1)
        self.assertIn("AWS_ACTIVE", self.store.transitions)
        self.assertEqual(self.store.fence, "GCP_FENCE_PENDING")
        self.assertTrue(all(call.args[1] is True for call in self.routing.set_closed.call_args_list))

    def test_sql_commit_followed_by_failure_recovers_without_source_or_repromotion(self):
        self.sql.crash_after_commit = True
        self.assertEqual(self.worker.run(self.app), "BLOCKED_OPERATION")
        self.sql.source_available = False
        self.signals.outage_confirmed.return_value = False
        self.sql.connected.clear()
        self.assertEqual(self.worker.run(self.app), "AWS_ACTIVE")
        self.assertEqual(self.sql.connected, ["target"])
        self.assertEqual(self.sql.promotions, 1)

    def test_pause_during_promotion_does_not_open_target(self):
        self.sql.on_promote = lambda: setattr(self.store, "paused", True)
        self.assertEqual(self.worker.run(self.app), "PAUSED_OR_LEASE_LOST")
        self.assertEqual(self.sql.promotions, 0)
        self.assertTrue(self.store.released)

    def test_interrupted_sql_state_can_resume_after_subscription_disable(self):
        self.sql.saved = "PROMOTING"
        self.sql.ready = False
        self.assertEqual(self.worker.run(self.app), "AWS_ACTIVE")

    def test_gcp_recovery_does_not_cause_an_automatic_failback(self):
        self.store.active = True
        self.sql.saved = "AWS_ACTIVE"
        self.signals.outage_confirmed.return_value = False
        self.assertEqual(self.worker.run(self.app), "AWS_ACTIVE")
        self.assertEqual(self.sql.promotions, 0)
        self.assertNotIn("source", self.sql.connected)

    def test_private_source_still_reachable_blocks_public_false_positive(self):
        self.signals.source_available.return_value = True
        self.assertEqual(self.worker.run(self.app), "WAIT_PRIVATE_SOURCE")
        self.assertEqual(self.sql.promotions, 0)
        self.routing.set_closed.assert_not_called()

    def test_no_prior_replication_evidence_blocks_total_outage(self):
        self.store.evidence = None
        self.assertEqual(self.worker.run(self.app), "BLOCKED_UNKNOWN_OR_STALE_REPLICATION")
        self.assertEqual(self.sql.promotions, 0)

    def test_source_return_is_closed_without_reopening_primary_dns(self):
        self.sql.saved = "AWS_ACTIVE"
        self.signals.source_available.return_value = True
        self.assertEqual(self.worker.run(self.app), "AWS_ACTIVE")
        self.assertEqual(self.sql.fences, 1)
        self.assertEqual(self.store.fence, "GCP_FENCED")
        self.routing.set_closed.assert_called_once_with(self.app, True)
        self.assertEqual(self.sql.promotions, 0)

    def test_fence_error_on_return_does_not_erase_aws_active(self):
        self.sql.saved = "AWS_ACTIVE"
        self.signals.source_available.return_value = True
        self.sql.source_available = False
        self.assertEqual(self.worker.run(self.app), "AWS_ACTIVE")
        self.assertTrue(self.store.active)
        self.assertEqual(self.store.fence, "GCP_FENCE_RETRY")

    def test_routing_lock_failure_prevents_promotion(self):
        self.routing.set_closed.side_effect = RuntimeError("AWS unavailable")
        self.assertEqual(self.worker.run(self.app), "BLOCKED_OPERATION")
        self.assertEqual(self.sql.promotions, 0)

    def test_paused_before_promotion_never_opens_target(self):
        self.sql.on_promote = lambda: setattr(self.store, "paused", True)
        self.assertEqual(self.worker.run(self.app), "PAUSED_OR_LEASE_LOST")
        self.assertEqual(self.sql.promotions, 0)


class SignalsTests(unittest.TestCase):
    def setUp(self):
        self.app, self.cloudwatch = profile(), Mock()
        self.now = 2000000000
        self.alarm = {"AlarmArn": "arn:aws:cloudwatch:us-east-1:626278345026:alarm:" + self.app["alarm_name"],
            "Namespace": "AWS/Route53", "MetricName": "HealthCheckStatus",
            "Dimensions": [{"Name": "HealthCheckId", "Value": self.app["health_check_id"]}],
            "StateValue": "ALARM", "StateTransitionedTimestamp": self.at(-120)}
        self.cloudwatch.describe_alarms.return_value = {"MetricAlarms": [self.alarm]}
        self.cloudwatch.get_metric_statistics.return_value = {"Datapoints": [{"Timestamp": self.at(-40), "Maximum": 0}]}
        self.probe = Mock(return_value=False)
        self.signals = a.CloudSignals(self.cloudwatch, clock=lambda: self.now, probe=self.probe)

    def at(self, delta):
        return datetime.fromtimestamp(self.now + delta, timezone.utc)

    def test_public_health_is_required_in_addition_to_route53(self):
        self.assertTrue(self.signals.outage_confirmed(self.app))
        self.probe.return_value = True
        self.assertFalse(self.signals.outage_confirmed(self.app))

    def test_a_young_alarm_is_waited_for_then_read_again(self):
        # Alarme de 20 s : le worker attend les 10 s restantes puis relit l'alarme au lieu d'abandonner jusqu'au passage suivant.
        def sleep(seconds):
            self.slept, self.now = seconds, self.now + seconds
            self.cloudwatch.get_metric_statistics.return_value = {"Datapoints": [{"Timestamp": self.at(-30), "Maximum": 0}]}
        self.signals.sleep = sleep
        self.alarm["StateTransitionedTimestamp"] = self.at(-20)
        self.assertTrue(self.signals.outage_confirmed(self.app))
        self.assertEqual(self.slept, 10)
        self.assertEqual(self.cloudwatch.describe_alarms.call_count, 2)

    def test_an_alarm_back_to_normal_during_the_wait_cannot_promote(self):
        def sleep(seconds):
            self.now += seconds
            self.alarm["StateValue"] = "OK"
        self.signals.sleep = sleep
        self.alarm["StateTransitionedTimestamp"] = self.at(-20)
        self.assertFalse(self.signals.outage_confirmed(self.app))
        self.probe.assert_not_called()

    def test_non_alarm_cannot_promote(self):
        self.alarm["StateValue"] = "INSUFFICIENT_DATA"
        self.assertFalse(self.signals.outage_confirmed(self.app))
        self.probe.assert_not_called()

    def test_other_application_alarm_is_refused(self):
        self.alarm["Dimensions"][0]["Value"] = "another-app"
        with self.assertRaisesRegex(a.Blocked, "BLOCKED_ALARM"):
            self.signals.outage_confirmed(self.app)

    def test_stale_or_missing_metrics_block_instead_of_becoming_a_panne(self):
        for points in ([], [{"Timestamp": self.at(-121), "Maximum": 0}]):
            self.cloudwatch.get_metric_statistics.return_value = {"Datapoints": points}
            with self.assertRaisesRegex(a.Blocked, "BLOCKED_STALE_METRIC"):
                self.signals.outage_confirmed(self.app)
        self.probe.assert_not_called()

    def test_a_new_healthy_metric_overrides_an_old_failure(self):
        self.cloudwatch.get_metric_statistics.return_value = {"Datapoints": [
            {"Timestamp": self.at(-100), "Maximum": 0}, {"Timestamp": self.at(-40), "Maximum": 1}]}
        self.assertFalse(self.signals.outage_confirmed(self.app))

    def test_future_alarm_is_not_treated_as_a_long_outage(self):
        self.alarm["StateTransitionedTimestamp"] = self.at(30)
        with self.assertRaises(a.Blocked):
            self.signals.outage_confirmed(self.app)


class ClientBoundaryTests(unittest.TestCase):
    def test_https_connect_uses_fixed_ip_but_preserves_certificate_name(self):
        with patch.object(a.ssl, "create_default_context") as context, patch.object(a.socket, "create_connection") as connect:
            conn = a.FixedHTTPS("app4-pixelcam.apps.mooroon5.fr", "34.160.1.1")
            conn.connect()
            self.assertEqual(connect.call_args.args[0], ("34.160.1.1", 443))
            self.assertEqual(context.return_value.wrap_socket.call_args.kwargs["server_hostname"], "app4-pixelcam.apps.mooroon5.fr")
            conn.close()

    def test_http_redirect_is_not_followed_and_connection_is_closed(self):
        with patch.object(a, "FixedHTTPS") as connection:
            conn = connection.return_value
            conn.getresponse.return_value.status = 302
            self.assertFalse(a.public_health(profile()))
            self.assertEqual(conn.request.call_count, 1)
            self.assertEqual(conn.request.call_args.kwargs["headers"]["Host"], profile()["hostname"])
            conn.close.assert_called_once()

    def test_simulation_never_constructs_aws_clients(self):
        with patch.dict(os.environ, {"CNP_CONFIG_TABLE": a.PLATFORM["config_table"]}), \
                patch.object(a, "aws_components") as aws, patch.object(a, "aws_session") as session, \
                patch("sys.stdout", new_callable=io.StringIO):
            for op in ("run", "configure", "pause", "resume", "status", "failback-route", "rearm"):
                self.assertEqual(a.main([op, "--app", "weather-api"]), 0)
            aws.assert_not_called()
            session.assert_not_called()

    def test_the_historical_configuration_from_the_environment_is_refused(self):
        config = json.dumps({"applications": [profile()]})
        with patch.dict(os.environ, {"CNP_AUTOMATION_CONFIG": config}), patch.object(a, "aws_session") as session, \
                patch("sys.stdout", new_callable=io.StringIO), patch("sys.stderr", new_callable=io.StringIO):
            os.environ.pop("CNP_CONFIG_TABLE", None)
            self.assertEqual(a.main(["run", "--execute"]), 1)
            session.assert_not_called()

    def test_config_rejects_dev_unknown_fields_wrong_account_and_public_sql(self):
        cases = []
        for path, value in [("hostname", "app4-pixelcam.dev.apps.mooroon5.fr"), ("profile", "unknown"),
                ("password", "secret"), ("gcp_lb_ip", "127.0.0.1")]:
            app = profile(); app[path] = value; cases.append(app)
        for side, key, value in [("source", "host", "8.8.8.8"), ("target", "host", "evil.example.com"),
                ("source", "secret_arn", profile()["source"]["secret_arn"].replace(a.ACCOUNT, "111111111111"))]:
            app = profile(); app[side][key] = value; cases.append(app)
        with patch.object(a.ssl, "create_default_context"):
            for app in cases:
                with self.subTest(app=app), self.assertRaises((a.Blocked, ValueError)):
                    a.validate({"applications": [app]})

    def test_changed_ca_or_endpoint_changes_configuration_identity(self):
        app = profile(); old = a.config_hash(app)
        app["source"]["host"] = "10.189.0.4"
        self.assertNotEqual(old, a.config_hash(app))


class StoreBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.ddb, self.sns = Mock(), Mock()
        self.store = a.Store(self.ddb, "table", "topic", self.sns, clock=lambda: 1000)

    def test_unknown_configuration_cannot_implicitly_resume(self):
        self.store.pause(profile(), False)
        request = self.ddb.update_item.call_args.kwargs
        self.assertIn("attribute_exists(app)", request["ConditionExpression"])
        self.assertIn("config_hash=:hash", request["ConditionExpression"])

    def test_fencing_status_is_journalled_without_overwriting_aws_active(self):
        self.ddb.get_item.return_value={'Item':a.item({'state':'AWS_ACTIVE'})}
        with patch('sys.stdout',new_callable=io.StringIO):
            self.store.transition(profile(),'worker1','GCP_FENCE_PENDING',field='source_fence')
        update=self.ddb.transact_write_items.call_args.kwargs['TransactItems'][0]['Update']
        self.assertEqual(update['ExpressionAttributeNames']['#s'],'source_fence')

    def test_stale_replication_and_evidence_from_another_profile_are_refused(self):
        known={'config_hash':a.config_hash(profile()),'observed_at':990,'last_message_at':980,'replayed_lsn':'0/AB'}
        self.ddb.get_item.return_value={'Item':a.item(known)}
        self.assertEqual(self.store.replication_evidence(profile())['replayed_lsn'],'0/AB')
        for key,value in [('observed_at',399),('config_hash','another-profile'),('last_message_at',1),('observed_at',1001)]:
            bad={**known,key:value}
            self.ddb.get_item.return_value={'Item':a.item(bad)}
            with self.assertRaisesRegex(a.Blocked,'BLOCKED_UNKNOWN_OR_STALE_REPLICATION'):
                self.store.replication_evidence(profile())

    def test_reading_a_stale_catalogue_does_not_refresh_last_healthy_evidence(self):
        self.store.remember_replication(profile(),'worker1',{'enabled':True,'tables_ready':True,
            'replayed_lsn':'0/AB','last_message_at':900})
        self.ddb.put_item.assert_not_called()

    def test_lease_takeover_requires_expiry_and_rechecks_pause(self):
        self.store.acquire(profile(), "worker1")
        acquire = self.ddb.update_item.call_args.kwargs
        self.assertIn("lease_until < :now", acquire["ConditionExpression"])
        self.assertIn("paused=:no", acquire["ConditionExpression"])
        self.store.checkpoint(profile(), "worker1")
        heartbeat = self.ddb.update_item.call_args.kwargs
        self.assertIn("lease_owner=:owner", heartbeat["ConditionExpression"])
        self.assertIn("lease_until >= :now", heartbeat["ConditionExpression"])
        self.assertIn("paused=:no", heartbeat["ConditionExpression"])

    def test_state_and_notification_are_saved_atomically(self):
        self.ddb.get_item.return_value = {"Item": a.item({"state": "DISABLED"})}
        with patch("sys.stdout", new_callable=io.StringIO):
            self.store.transition(profile(), "worker1", "AWS_ACTIVE")
        writes = self.ddb.transact_write_items.call_args.kwargs["TransactItems"]
        self.assertEqual(len(writes), 2)
        event = a.decode(writes[1]["Put"]["Item"])
        self.assertFalse(event["delivered"])
        self.assertEqual(event["state"], "AWS_ACTIVE")
        self.assertNotIn("password", json.dumps(writes))

    def test_failed_notification_is_left_pending_and_retried(self):
        event = a.item({"app": "app4-pixelcam", "record": "EVENT#123", "state": "AWS_ACTIVE", "at": 123, "delivered": False})
        self.ddb.query.return_value = {"Items": [event]}
        self.sns.publish.side_effect = RuntimeError("unavailable")
        with self.assertRaises(RuntimeError):
            self.store.notify_pending("app4-pixelcam")
        self.ddb.update_item.assert_not_called()
        self.sns.publish.side_effect = None
        self.store.notify_pending("app4-pixelcam")
        self.ddb.update_item.assert_called_once()

    def test_pending_notifications_are_paginated(self):
        self.ddb.query.side_effect = [{"Items": [], "LastEvaluatedKey": a.item({"app": "a", "record": "b"})}, {"Items": []}]
        self.store.notify_pending("app4-pixelcam")
        self.assertEqual(self.ddb.query.call_count, 2)
        self.assertIn("ExclusiveStartKey", self.ddb.query.call_args.kwargs)


class RoutingGateTests(unittest.TestCase):
    def setUp(self):
        self.app=profile();self.closed=False;self.client=Mock()
        self.parent={'Type':'CALCULATED','HealthThreshold':2,
            'ChildHealthChecks':[self.app['health_check_id'],self.app['routing_latch_id']]}
        def get(HealthCheckId):
            config = self.parent if HealthCheckId == self.app['primary_health_check_id'] else {
                'Type':'HTTPS','Disabled':True,'Inverted':self.closed,
                'IPAddress':self.app['gcp_lb_ip'],'FullyQualifiedDomainName':self.app['hostname'],
                'Port':443,'ResourcePath':'/health','EnableSNI':True}
            return {'HealthCheck':{'HealthCheckConfig':deepcopy(config),'HealthCheckVersion':1}}
        def update(**kwargs):self.closed=kwargs['Inverted']
        self.client.get_health_check.side_effect=get
        self.client.update_health_check.side_effect=update
        self.gate=a.RoutingGate(self.client)

    def test_closure_is_idempotent_and_uses_versioned_update(self):
        self.gate.set_closed(self.app,True)
        self.gate.set_closed(self.app,True)
        self.client.update_health_check.assert_called_once_with(HealthCheckId=self.app['routing_latch_id'],
            HealthCheckVersion=1,Inverted=True)
        self.assertTrue(self.closed)

    def test_opening_restores_constant_healthy_latch(self):
        self.closed=True
        self.gate.set_closed(self.app,False)
        self.assertFalse(self.closed)
        self.client.update_health_check.assert_called_once_with(HealthCheckId=self.app['routing_latch_id'],
            HealthCheckVersion=1,Inverted=False)

    def test_nested_calculated_gate_is_rejected(self):
        self.client.get_health_check.side_effect=[
            {'HealthCheck':{'HealthCheckConfig':self.parent}},
            {'HealthCheck':{'HealthCheckConfig':{'Type':'CALCULATED','HealthThreshold':1,'Inverted':True},'HealthCheckVersion':1}}]
        with self.assertRaisesRegex(a.Blocked,'BLOCKED_ROUTING_CONFIG'):
            self.gate.set_closed(self.app,True)
        self.client.update_health_check.assert_not_called()

    def test_other_app_inverted_or_disabled_parent_cannot_be_used(self):
        for key,value in [('ChildHealthChecks',['other-app']),('HealthThreshold',1),('Inverted',True),('Disabled',True)]:
            previous=deepcopy(self.parent);self.parent[key]=value
            with self.assertRaisesRegex(a.Blocked,'BLOCKED_ROUTING_CONFIG'):self.gate.set_closed(self.app,True)
            self.parent=previous
        self.client.update_health_check.assert_not_called()


if __name__ == "__main__":
    unittest.main()
