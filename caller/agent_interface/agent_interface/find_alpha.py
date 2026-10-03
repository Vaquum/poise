from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path


ROOT = Path(os.getenv("TMPDIR", "/tmp")) / "agent-interface" / "find-alpha"
LIMEN_TEMPLATE = Path("/Users/mikkokotila/dev/Limen/limen/yaml/templates/logreg_binary.yaml")
RULE_TEMPLATE = Path("/Users/mikkokotila/dev/Limen/limen/yaml/templates/rule_based.yaml")


def safe(value: str) -> str:
    return "".join(c if c.isalnum() or c in "._-" else "_" for c in value) or "session"


def workdir(session_id: str) -> Path:
    path = ROOT / safe(session_id)
    path.mkdir(parents=True, exist_ok=True)
    return path.resolve()


def ensure_manifest(path: Path, topic: str):
    if path.exists():
        return
    template = RULE_TEMPLATE if "rule" in topic.lower() and RULE_TEMPLATE.exists() else LIMEN_TEMPLATE
    if template.exists():
        shutil.copy2(template, path)
        text = path.read_text()
        if "output_path:" not in text:
            text = text.rstrip() + "\n  output_path: ./results\n"
        if "tiny" in topic.lower():
            text = text.replace("n_permutations: 50", "n_permutations: 4")
        path.write_text(text)
    else:
        path.write_text("schema_version: \"1.0\"\nmetadata:\n  name: find_alpha\n  mode: development\n")


def round_count(topic: str) -> int:
    text = topic.lower()
    exact = re.search(r"exactly\s+(\d+)\s+(?:optimization\s+)?round", text)
    if exact:
        return int(exact.group(1))
    cap = re.search(r"(?:no more than|never more than|max(?:imum)?)\s+(\d+).*round", text)
    return int(cap.group(1)) if cap else 20


def permutation_cap(topic: str) -> int | None:
    text = topic.lower()
    found = re.search(r"(?:n_permutations|permutations).*?(?:max|<=|under|no more than)?\s*(\d+)", text)
    if found:
        return int(found.group(1))
    return 4 if "tiny" in text else None


def set_yaml_value(path: Path, key: str, value: str):
    lines = path.read_text().splitlines()
    for i, line in enumerate(lines):
        if line.lstrip().startswith(f"{key}:"):
            lines[i] = f"{line[:len(line) - len(line.lstrip())]}{key}: {value}"
            break
    else:
        lines.append(f"  {key}: {value}")
    path.write_text("\n".join(lines) + "\n")


def install_limen(cwd: Path):
    with (cwd / "limen-install.log").open("w") as log:
        done = subprocess.run(["conda", "run", "-n", "limen", "python", "-m", "pip", "install", "-U", "vaquum_limen"], cwd=cwd, text=True, stdout=log, stderr=subprocess.STDOUT, timeout=600)
    if done.returncode:
        raise RuntimeError((cwd / "limen-install.log").read_text()[-4000:])


def run_limen(cwd: Path, timeout_s: int):
    done = subprocess.run(["conda", "run", "-n", "limen", "limen", "run", "manifest.yml"], cwd=cwd, text=True, capture_output=True, timeout=timeout_s)
    if done.returncode:
        raise RuntimeError((done.stderr or done.stdout).strip() or f"limen exited {done.returncode}")


def run(topic: str, model: str, session_id: str, timeout_s: int = 3600) -> str:
    cwd = workdir(session_id)
    manifest = cwd / "manifest.yml"
    ensure_manifest(manifest, topic)
    total = round_count(topic)
    cap = permutation_cap(topic)
    results: list[Path] = []
    install_limen(cwd)
    for i in range(1, total + 1):
        set_yaml_value(manifest, "output_path", f"./round_{i}")
        if cap:
            set_yaml_value(manifest, "n_permutations", str(cap))
        run_limen(cwd, min(timeout_s, 600))
        result = cwd / f"round_{i}" / "results.csv"
        if not result.exists():
            raise RuntimeError(f"missing results: {result}")
        results.append(result)
    response = f"completed {total} Limen round(s); final results: {results[-1]}"
    return json.dumps(
        {
            "response": response,
            "session_id": session_id,
            "pwd": str(cwd),
            "manifest": str(manifest),
            "results": [str(p) for p in results],
            "allowed": ["conda run -n limen python -m pip install -U vaquum_limen", "conda run -n limen limen run manifest.yml"],
        },
        indent=2,
    )
