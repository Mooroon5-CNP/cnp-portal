"""Vérifie que la pause est consultée avant clôture et avant commit SQL."""
from contextlib import contextmanager
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import database

import postgres_contract
# Profil de la plateforme : le schéma se lit dans la base. Le faux serveur « découvre » une table et sa séquence.
PROFILE = postgres_contract.encode({'database': 'pixelcalm'})
DISCOVERED = {'tables': ['pensees'], 'sequences': [('pensees', 'id', 'pensees_id_seq')], 'unsupported': [],
              'needs_full_identity': [], 'extensions': []}
_discover = patch.object(database, 'discover', return_value=DISCOVERED)


def setUpModule():
    _discover.start()


def tearDownModule():
    _discover.stop()



class Result:
    def __init__(self, row=None, rows=()):
        self.row, self.rows = row, rows

    def fetchone(self):
        return self.row

    def fetchall(self):
        return self.rows


class Target:
    def __init__(self):
        self.state, self.login, self.barrier = None, False, None
        self.committed = False

    def execute(self, query, params=None):
        text = query if isinstance(query, str) else query.as_string()
        if "pg_try_advisory_lock" in text:
            return Result((True,))
        if "increment_by" in text:
            return Result((1, 1, False))
        if text.startswith("SELECT state,barrier"):
            return Result((self.state, self.barrier, PROFILE) if self.state else None)
        if "SELECT rolcanlogin" in text:
            return Result((self.login,))
        if "INSERT INTO public.cnp_recovery" in text:
            self.state, self.barrier = "PROMOTING", params[0]
        if "pg_stat_subscription" in text:
            return Result()
        if text.startswith('ALTER ROLE "cnp_runtime" LOGIN'):
            self.login = True
        if text.startswith("UPDATE public.cnp_recovery"):
            self.state = "AWS_ACTIVE"
        return Result()

    @contextmanager
    def transaction(self):
        original = self.state, self.login
        try:
            yield
        except BaseException:
            self.state, self.login = original
            raise
        else:
            self.committed = True


class PromotionGuardsTests(unittest.TestCase):
    def test_pause_before_any_fence_does_not_close_gcp_or_open_aws(self):
        source, target = Mock(), Target()
        with self.assertRaisesRegex(RuntimeError, "pause"):
            database.promote_after_fence(source, target, profile=PROFILE,
                checkpoint=Mock(side_effect=RuntimeError("pause")))
        source.execute.assert_not_called()
        self.assertFalse(target.login)
        self.assertFalse(target.committed)

    def test_pause_at_final_checkpoint_is_inside_sql_transaction(self):
        source, target = Mock(), Target()
        def checkpoint():
            if target.state == "AWS_ACTIVE":
                raise RuntimeError("pause before commit")
        with patch.object(database, "fence_source", return_value="barrier-id"), \
                patch.object(database, "wait_replay"), self.assertRaisesRegex(RuntimeError, "pause before commit"):
            database.promote_after_fence(source, target, profile=PROFILE, checkpoint=checkpoint)
        self.assertEqual(target.state, "PROMOTING")
        self.assertFalse(target.login)
        self.assertFalse(target.committed)

    def test_unknown_saved_state_is_rejected_without_a_second_fence(self):
        source, target = Mock(), Target()
        target.state, target.barrier = "UNRECOGNIZED", "old-barrier"
        with self.assertRaisesRegex(ValueError, "État de reprise inconnu"):
            database.promote_after_fence(source, target, profile=PROFILE)
        source.execute.assert_not_called()
        self.assertFalse(target.login)

    def test_same_number_of_replicated_tables_is_not_enough(self):
        conn = Mock()
        conn.execute.side_effect = [Result((1, True)), Result(rows=[
            ("r", "public", "entries"), ("r", "public", "replication_barrier")]), Result(("0/AB",))]
        self.assertFalse(database.progress(conn, PROFILE)["tables_ready"])


class StuckWorkerTests(unittest.TestCase):
    def test_a_worker_stuck_connecting_to_the_dead_source_is_terminated(self):
        # Observé le 06/11/2026 : désactivé, le processus de réplication restait ~2 min dans sa connexion vers GCP en panne.
        calls, alive = [], [True]
        class Stuck:
            def execute(self, query, params=None):
                text = query if isinstance(query, str) else query.as_string()
                calls.append(text)
                if "pg_terminate_backend" in text:
                    alive[0] = False
                if text.startswith("SELECT 1 FROM pg_stat_subscription"):
                    return Result((1,) if alive[0] else None)
                return Result()
        database.stop_subscription(Stuck(), timeout=0.5, checkpoint=lambda: None, blocked="bloqué")
        self.assertTrue(calls[0].startswith("ALTER SUBSCRIPTION"))
        self.assertTrue(any("pg_terminate_backend" in text for text in calls))


if __name__ == "__main__":
    unittest.main()
