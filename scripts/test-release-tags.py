"""Exercise tag promotion against a disposable Git repository."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('release-tags.sh').resolve()


class ReleaseTagsTest(unittest.TestCase):
    def test_publication_matrix(self):
        with tempfile.TemporaryDirectory() as directory:
            def git(*args):
                return subprocess.check_output(['git', '-C', directory, *args], text=True).strip()

            git('init', '-q')
            git('-c', 'user.name=Test', '-c', 'user.email=test@example.com',
                'commit', '--allow-empty', '-qm', 'test')
            sha = git('rev-parse', 'HEAD')
            git('update-ref', 'refs/remotes/origin/main', sha)
            for tag in ['v1.0.0', 'v1.2.0', 'v1.10.0', 'v2.0.0-rc.1']:
                git('tag', tag)

            def run(ref, commit=sha):
                return subprocess.run(['bash', str(SCRIPT)], cwd=directory,
                    env={**os.environ, 'IMAGE': 'ghcr.io/test/app',
                         'GITHUB_REF': ref, 'GITHUB_SHA': commit},
                    capture_output=True, text=True)

            for ref, aliases in [
                ('refs/heads/main', ['dev']),
                ('refs/heads/feature', []),
                ('refs/tags/v1.0.0', ['v1.0.0']),
                ('refs/tags/v1.10.0', ['v1.10.0', 'latest']),
                ('refs/tags/v2.0.0-rc.1', ['v2.0.0-rc.1']),
            ]:
                with self.subTest(ref=ref):
                    result = run(ref)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stdout.splitlines(),
                        [f'ghcr.io/test/app:{tag}' for tag in [f'sha-{sha}', *aliases]])
            self.assertNotIn(':dev', run('refs/heads/main', '0' * 40).stdout)
            for tag in ['vtest', 'v01.2.3', 'v1.2', 'v1.2.3+build', 'v1.2.3-rc.01']:
                self.assertNotEqual(run(f'refs/tags/{tag}').returncode, 0)


if __name__ == '__main__':
    unittest.main()
