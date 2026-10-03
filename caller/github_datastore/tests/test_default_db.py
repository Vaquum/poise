from __future__ import annotations

from pathlib import Path

import pytest

from github_datastore import cli, db


def test_the_default_database_is_in_the_users_data_directory(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))
    assert db.default_db() == str(tmp_path / "data" / "github-datastore" / "github_datastore.sqlite")
    monkeypatch.delenv("XDG_DATA_HOME")
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    assert db.default_db() == str(tmp_path / "home" / ".local" / "share" / "github-datastore" / "github_datastore.sqlite")


def test_help_names_no_account_and_shows_the_default(capsys):
    with pytest.raises(SystemExit):
        cli.main(["--help"])
    text = capsys.readouterr().out
    assert db.DEFAULT_DB in text
    assert "--username LOGIN" in text


def test_a_database_can_start_in_a_directory_that_does_not_exist_yet(tmp_path):
    path = tmp_path / "data" / "github-datastore" / "github_datastore.sqlite"
    db.connect(path).close()
    assert Path(path).is_file()
