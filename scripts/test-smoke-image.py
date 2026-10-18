"""Verify startup retries and cleanup without requiring a Docker daemon."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('smoke-image.sh').resolve()


class SmokeImageTest(unittest.TestCase):
    def run_smoke(self, failures):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            commands = {
                'docker': '''#!/bin/bash
case "$1" in
  run) [[ "$2" != -d ]] || echo test-container ;;
  port) echo 127.0.0.1:12345 ;;
  logs) echo logs >> "$TEST_ROOT/cleanup" ;;
  rm) echo removed >> "$TEST_ROOT/cleanup" ;;
esac
''',
                'curl': '''#!/bin/bash
if [[ "${@: -1}" == */healthz ]]; then
  count=0
  [[ ! -f "$TEST_ROOT/probes" ]] || read -r count < "$TEST_ROOT/probes"
  count=$((count + 1))
  echo "$count" > "$TEST_ROOT/probes"
  if ((count <= FAILURES)); then
    echo 'curl: (56) Recv failure: Connection reset by peer' >&2
    exit 56
  fi
  echo ok
else
  echo requested > "$TEST_ROOT/spa"
  echo '<html></html>'
fi
''',
                'sleep': '#!/bin/bash\nexit 0\n',
            }
            for name, content in commands.items():
                command = root / name
                command.write_text(content)
                command.chmod(0o755)
            result = subprocess.run(['bash', str(SCRIPT), 'test-image'],
                env={**os.environ, 'PATH': f'{root}:{os.environ["PATH"]}',
                     'TEST_ROOT': str(root), 'FAILURES': str(failures)},
                capture_output=True, text=True, timeout=10)
            self.assertEqual((root / 'cleanup').read_text(), 'logs\nremoved\n')
            return result, int((root / 'probes').read_text()), (root / 'spa').exists()

    def test_connection_resets_then_ready(self):
        result, probes, spa = self.run_smoke(2)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(probes, 3)
        self.assertTrue(spa)

    def test_persistent_failure_is_bounded(self):
        result, probes, spa = self.run_smoke(100)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('did not become healthy', result.stderr)
        self.assertEqual(probes, 20)
        self.assertFalse(spa)


if __name__ == '__main__':
    unittest.main()
