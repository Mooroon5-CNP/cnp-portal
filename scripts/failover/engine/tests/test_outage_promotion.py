"""Panne totale, reprise SQL et pause ; aucune connexion à un cloud."""
from contextlib import contextmanager
from copy import deepcopy
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

from test_promotion_guards import Result


class Target:
    def __init__(self):
        self.state, self.login, self.mode, self.incident = None, False, "UNREACHABLE", None
        self.enabled, self.replay, self.committed = True, "0/1234", False
        self.operations = []

    def execute(self, query, params=None):
        text = query if isinstance(query, str) else query.as_string()
        self.operations.append(text)
        if 'pg_try_advisory_lock' in text:
            return Result((True,))
        if 'increment_by' in text:
            return Result((1, 1, False))
        if text.startswith('SELECT state,barrier'):
            return Result((self.state,self.incident,PROFILE,self.mode,{}) if self.state else None)
        if 'SELECT rolcanlogin' in text:
            return Result((self.login,))
        if text.startswith('SELECT oid,subenabled'):
            return Result((1,self.enabled))
        if 'FROM pg_subscription_rel' in text:
            return Result(rows=[('r','public','pensees'),('r','public','replication_barrier')])
        if 'remote_lsn::text' in text:
            return Result((self.replay,))
        if text.startswith('INSERT INTO public.cnp_recovery'):
            self.state, self.incident = 'PROMOTING', params[0]
        if 'ALTER SUBSCRIPTION' in text:
            self.enabled = False
        if text.startswith('ALTER ROLE "cnp_runtime" LOGIN'):
            self.login = True
        if text.startswith('UPDATE public.cnp_recovery'):
            self.state = 'AWS_ACTIVE'
        return Result()

    @contextmanager
    def transaction(self):
        previous = self.state, self.login
        try:
            yield
        except BaseException:
            self.state, self.login = previous
            raise
        else:
            self.committed = True


def evidence():
    return {'observed_at':1000,'last_message_at':990,'replayed_lsn':'0/1234',
        'source_unreachable':True,'public_unreachable':True}


class OutagePromotionTests(unittest.TestCase):
    def test_total_outage_opens_aws_after_stopping_replication_and_realigning_sequence(self):
        target = Target()
        result = database.promote_unreachable(target,evidence(),profile=PROFILE)
        self.assertEqual(result['state'],'AWS_ACTIVE')
        self.assertFalse(result['zero_loss_proven'])
        self.assertNotIn('barrier',result)
        self.assertFalse(target.enabled)
        self.assertTrue(target.login)
        stop = next(i for i,q in enumerate(target.operations) if 'ALTER SUBSCRIPTION' in q)
        sequence = next(i for i,q in enumerate(target.operations) if 'setval(' in q)
        opening = next(i for i,q in enumerate(target.operations) if 'ALTER ROLE' in q)
        self.assertLess(stop,sequence)
        self.assertLess(sequence,opening)

    def test_pause_before_mutation_opens_nothing(self):
        target = Target()
        with self.assertRaisesRegex(RuntimeError,'pause'):
            database.promote_unreachable(target,evidence(),profile=PROFILE,
                checkpoint=Mock(side_effect=RuntimeError('pause')))
        self.assertFalse(target.login)
        self.assertIsNone(target.state)

    def test_pause_before_commit_rolls_back_login_then_resumes_same_incident(self):
        target = Target()
        def checkpoint():
            if target.state == 'AWS_ACTIVE':
                raise RuntimeError('pause')
        with self.assertRaisesRegex(RuntimeError,'pause'):
            database.promote_unreachable(target,evidence(),profile=PROFILE,checkpoint=checkpoint)
        incident = target.incident
        self.assertEqual(target.state,'PROMOTING')
        self.assertFalse(target.login)
        self.assertFalse(target.enabled)
        result = database.promote_unreachable(target,{},profile=PROFILE)
        self.assertEqual(result['incident'],str(incident))
        self.assertTrue(target.login)

    def test_repeated_event_does_not_realign_or_reopen_a_committed_target(self):
        target = Target()
        first = database.promote_unreachable(target,evidence(),profile=PROFILE)
        target.operations.clear()
        self.assertEqual(first,database.promote_unreachable(target,{},profile=PROFILE))
        self.assertFalse(any('setval(' in q or 'ALTER ROLE' in q for q in target.operations))

    def test_missing_evidence_or_partial_initial_copy_never_opens_target(self):
        for key in ('replayed_lsn','observed_at','source_unreachable','public_unreachable'):
            proof = evidence(); proof.pop(key)
            target = Target()
            with self.assertRaises(ValueError):
                database.promote_unreachable(target,proof,profile=PROFILE)
            self.assertFalse(target.login)
        target = Target()
        with patch.object(database,'progress',return_value={'enabled':True,'tables_ready':False}):
            with self.assertRaises(ValueError):
                database.promote_unreachable(target,evidence(),profile=PROFILE)
        self.assertFalse(target.login)

    def test_unknown_state_or_other_promotion_mode_is_not_adopted(self):
        for state, mode in [('UNKNOWN','UNREACHABLE'),('PROMOTING','FENCED')]:
            target=Target();target.state=state;target.mode=mode
            with self.assertRaises(ValueError):
                database.promote_unreachable(target,evidence(),profile=PROFILE)
            self.assertFalse(target.login)


if __name__ == '__main__':
    unittest.main()
