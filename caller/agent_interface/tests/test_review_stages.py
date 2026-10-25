import json
from unittest import TestCase

from agent_interface import review_stages


def section(path, body="@@ -1 +1 @@\n-old\n+new\n", old=None):
    old = path if old is None else old
    header = [f"diff --git a/{old} b/{path}"]
    if old != path:
        header += ["similarity index 90%", f"rename from {old}", f"rename to {path}"]
    header += [f"--- a/{old}", f"+++ b/{path}"]
    return "\n".join(header + [body])


def packet(paths, bodies=None, **extra):
    bodies = bodies or {}
    node = {"action": "read", "repository": "o/r", "pull_number": 12, "head_sha": "a" * 40,
            "pull": {"base": {"sha": "b" * 40}}, "merge_base_sha": "m" * 40,
            "review_threads": [], "linked_issues": [],
            "diff": "\n".join(section(path, bodies.get(path, "@@ -1 +1 @@\n-old\n+new\n")) for path in paths),
            "files": [{"filename": path, "status": "modified",
                       "old_mode": "100644", "new_mode": "100644"} for path in paths],
            "excluded_files": [],
            "review_scope": "Review the complete retained diff."}
    node.update(extra)
    return json.dumps(node, separators=(",", ":"))


class TestSplit(TestCase):
    def test_non_packet_input_runs_as_one_unchanged_stage(self):
        for raw in ("packet", "", "{}", "[]", json.dumps({"diff": "x"}),
                    json.dumps({"diff": "", "files": [{"filename": 7}]})):
            self.assertEqual(review_stages.split(raw), [raw])

    def test_small_packet_is_returned_byte_identical(self):
        raw = packet([f"src/f{i}.py" for i in range(8)])
        self.assertEqual(review_stages.split(raw), [raw])

    def test_ninth_file_opens_a_second_group(self):
        paths = [f"src/f{i:02d}.py" for i in range(9)]
        stages = review_stages.split(packet(paths))
        self.assertEqual(len(stages), 2)
        first, second = (json.loads(stage) for stage in stages)
        self.assertEqual([entry["filename"] for entry in first["files"]], paths[:8])
        self.assertEqual([entry["filename"] for entry in second["files"]], paths[8:])
        self.assertEqual(first["diff"].count("diff --git "), 8)
        self.assertEqual(second["diff"].count("diff --git "), 1)
        self.assertIn("file group 1 of 2", first["review_scope"])
        self.assertIn("Review ONLY the retained diff below", second["review_scope"])
        for stage in (first, second):
            self.assertEqual(stage["merge_base_sha"], "m" * 40)
            self.assertEqual(stage["head_sha"], "a" * 40)

    def test_diff_bytes_cap_groups_large_files(self):
        big = "x\n" * 60_000
        stages = review_stages.split(packet(["a.py", "b.py", "c.py"],
                                            {name: "@@ -1 +1 @@\n" + big for name in ("a.py", "b.py", "c.py")}))
        self.assertEqual(len(stages), 3)
        self.assertEqual([len(json.loads(stage)["files"]) for stage in stages], [1, 1, 1])

    def test_single_huge_file_stays_one_stage(self):
        raw = packet(["big.py"], {"big.py": "@@ -1 +1 @@\n" + "x\n" * 200_000})
        self.assertEqual(review_stages.split(raw), [raw])

    def test_renamed_old_path_stays_with_its_section(self):
        node = json.loads(packet(["new.py"]))
        node["diff"] = section("new.py", old="old.py")
        node["files"] = [{"filename": name, "status": status, "old_mode": "100644", "new_mode": "100644"}
                         for name, status in (("old.py", "removed"), ("new.py", "added"))]
        stages = review_stages.split(json.dumps(node))
        self.assertEqual(len(stages), 1)

    def test_pure_rename_binary_and_mode_sections_match(self):
        diff = "\n".join([
            "diff --git a/moved.py b/moved.py",
            "similarity index 100%", "rename from orig.py", "rename to moved.py",
            "diff --git a/img.png b/img.png",
            "Binary files a/img.png and b/img.png differ",
            "diff --git a/run.sh b/run.sh",
            "old mode 100644", "new mode 100755",
            "diff --git a/gone.py b/gone.py",
            "--- a/gone.py", "+++ /dev/null", "@@ -1 +0,0 @@\n-gone",
        ])
        node = json.loads(packet([]))
        node["diff"] = diff
        node["files"] = [{"filename": name, "status": status, "old_mode": "100644", "new_mode": "100644"}
                         for name, status in (("orig.py", "removed"), ("moved.py", "added"),
                                              ("img.png", "modified"), ("run.sh", "changed"),
                                              ("gone.py", "removed"))]
        self.assertEqual(review_stages.split(json.dumps(node)), [json.dumps(node)])

    def test_spaced_path_matches_its_plus_plus_plus_line(self):
        node = json.loads(packet([]))
        node["diff"] = section("my dir/file.txt")
        node["files"] = [{"filename": "my dir/file.txt", "status": "modified",
                          "old_mode": "100644", "new_mode": "100644"}]
        self.assertEqual(len(review_stages.split(json.dumps(node))), 1)

    def test_section_for_an_unretained_file_fails_loud(self):
        node = json.loads(packet(["kept.py"]))
        node["diff"] += "\n" + section("dropped.py")
        with self.assertRaisesRegex(review_stages.StageError, "dropped.py"):
            review_stages.split(json.dumps(node))

    def test_retained_file_without_a_section_fails_loud(self):
        node = json.loads(packet(["kept.py", "ghost.py"]))
        node["diff"] = section("kept.py")
        with self.assertRaisesRegex(review_stages.StageError, "ghost.py"):
            review_stages.split(json.dumps(node))

    def test_staged_follow_up_keeps_the_current_head_positioning(self):
        paths = [f"src/f{i:02d}.py" for i in range(9)]
        node = json.loads(packet(paths))
        node["since_head_sha"] = "c" * 40
        stages = review_stages.split(json.dumps(node))
        self.assertEqual(len(stages), 2)
        for stage in stages:
            scope = json.loads(stage)["review_scope"]
            self.assertIn("since the last reviewed head", scope)
            self.assertIn("RIGHT-side", scope)

    def test_bounded_packet_keeps_its_omitted_files_in_every_stage(self):
        paths = [f"src/f{i:02d}.py" for i in range(9)]
        raw = packet(paths, omitted_files=[{"path": "src/rest.py", "reason": "omitted"}])
        stages = review_stages.split(raw)
        self.assertEqual(len(stages), 2)
        for stage in stages:
            node = json.loads(stage)
            self.assertEqual(node["omitted_files"], [{"path": "src/rest.py", "reason": "omitted"}])
            self.assertIn("not reviewed in any stage", node["review_scope"])
