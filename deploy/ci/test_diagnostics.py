"""The logging deployment boundary survives changes to Compose and backups."""
from pathlib import Path
from unittest import TestCase

ROOT = Path(__file__).resolve().parents[2]


class DiagnosticDeploymentCase(TestCase):
    def test_host_journals_are_read_only_gateway_mounts_and_central_data_is_backed_up(self):
        compose = (ROOT / "deploy/compose.yaml").read_text()
        self.assertIn("- gateway-data:/data", compose)
        for path in ("/var/log/journal", "/run/log/journal", "/etc/machine-id"):
            self.assertIn(f"- {path}:{path}:ro", compose)
        workspace = (ROOT / "gateway/src/orchestrator.ts").read_text()
        self.assertNotIn("/var/log/journal", workspace)
        self.assertNotIn("gateway-data", workspace)
        self.assertNotIn("docker.sock", workspace)
        self.assertIn("gateway_volume=poise-gateway-data", (ROOT / "deploy/backup.sh").read_text())
        self.assertIn("systemd", (ROOT / "gateway/Dockerfile").read_text())
