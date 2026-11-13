"""Startup orchestration tests. No downloads, cloud calls, or server are started."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SOURCE = Path(__file__).resolve().parents[2] / 'start-postgres-local.sh'


class LocalStartupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'scripts/failover/engine').mkdir(parents=True)
        shutil.copyfile(SOURCE, self.root / 'scripts/start-postgres-local.sh')
        for name in ('requirements.txt', 'requirements.automation.txt', 'requirements.platform.txt'):
            (self.root / 'scripts/failover/engine' / name).write_text('# fixture\n')
        self.python = self.root / 'data/.venv-failover/bin/python'
        self.python.parent.mkdir(parents=True)
        self.python.write_text('''#!/usr/bin/python3
import os,sys
from pathlib import Path
args=sys.argv[1:]
if args[:2]==['-m','pip']:
    with open(os.environ['STARTUP_LOG'],'a') as out: out.write(' '.join(args)+'\\n')
    if 'install' in args and os.environ.get('FAIL_INSTALL'): sys.exit(23)
    if 'check' in args and os.environ.get('FAIL_CHECK'): sys.exit(1)
elif args==['-']:
    code=sys.stdin.read()
    if 'hashlib' in code: exec(code)
    elif os.environ.get('FAIL_IMPORT'): sys.exit(1)
    else: print('operator imports verified')
else: sys.exit(4)
''')
        self.python.chmod(0o700)
        bindir = self.root / 'bin'
        bindir.mkdir()
        npm = bindir / 'npm'
        npm.write_text('''#!/bin/sh
printf 'npm %s %s %s\n' "$*" "$CNP_FAILOVER_PYTHON" "$CNP_FAILOVER_OPERATOR_PYTHON" >> "$STARTUP_LOG"
''')
        npm.chmod(0o700)
        self.log = self.root / 'startup.log'
        self.env = {key: value for key, value in os.environ.items() if not key.startswith('CNP_FAILOVER_')}
        self.env.update(PATH=str(bindir) + os.pathsep + os.environ['PATH'], STARTUP_LOG=str(self.log))

    def run_startup(self, **extra):
        return subprocess.run(['bash', str(self.root / 'scripts/start-postgres-local.sh')],
                              env={**self.env, **extra}, capture_output=True, text=True, timeout=10)

    def test_first_start_installs_checks_and_passes_the_operator_to_the_portal(self):
        result = self.run_startup()
        self.assertEqual(result.returncode, 0, result.stderr)
        log = self.log.read_text()
        self.assertIn('pip install --prefer-binary', log)
        self.assertIn('pip check', log)
        self.assertIn(f'npm run dev {self.python} {self.python}', log)

    def test_next_start_skips_install_but_a_requirement_change_revalidates(self):
        self.assertEqual(self.run_startup().returncode, 0)
        self.log.write_text('')
        self.assertEqual(self.run_startup().returncode, 0)
        self.assertNotIn('pip install', self.log.read_text())
        (self.root / 'scripts/failover/engine/requirements.platform.txt').write_text('# changed\n')
        self.assertEqual(self.run_startup().returncode, 0)
        self.assertIn('pip install', self.log.read_text())

    def test_failed_install_never_starts_the_portal_or_marks_the_environment_ready(self):
        self.assertNotEqual(self.run_startup(FAIL_INSTALL='1').returncode, 0)
        self.assertNotIn('npm ', self.log.read_text())
        self.assertFalse((self.python.parent.parent / '.cnp-operator-requirements').exists())

    def test_broken_imports_cannot_reuse_an_old_ready_marker(self):
        self.assertEqual(self.run_startup().returncode, 0)
        self.log.write_text('')
        self.assertNotEqual(self.run_startup(FAIL_IMPORT='1').returncode, 0)
        self.assertIn('pip install', self.log.read_text())
        self.assertNotIn('npm ', self.log.read_text())

    def test_explicit_interpreter_is_verified_without_automatic_installation(self):
        result = self.run_startup(CNP_FAILOVER_OPERATOR_PYTHON=str(self.python))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('pip install', self.log.read_text())
        self.assertIn(f'npm run dev {self.python} {self.python}', self.log.read_text())


if __name__ == '__main__':
    unittest.main()
