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

    def test_spaced_path_matches_its_tab_terminated_plus_plus_plus_line(self):
        # Git terminates a space-containing ---/+++ path with a tab; the
        # parser must strip that terminator before matching retained files.
        node = json.loads(packet([]))
        node["diff"] = ("diff --git a/my dir/file.txt b/my dir/file.txt\n"
                        "--- a/my dir/file.txt\t\n"
                        "+++ b/my dir/file.txt\t\n"
                        "@@ -1 +1 @@\n-old\n+new\n")
        node["files"] = [{"filename": "my dir/file.txt", "status": "modified",
                          "old_mode": "100644", "new_mode": "100644"}]
        self.assertEqual(review_stages.split(json.dumps(node)), [json.dumps(node)])

    def test_quoted_plus_plus_plus_path_matches_its_retained_file(self):
        # Git C-quotes +++ paths holding double quotes, backslashes, or
        # non-ASCII bytes; the parser must unquote before matching.
        cases = [('we"ird.py', 'we\\"ird.py'),
                 ("back\\slash.py", "back\\\\slash.py"),
                 ("caf\u00e9.py", "caf\\303\\251.py")]
        for retained, quoted in cases:
            with self.subTest(retained=retained):
                diff = "\n".join([f'diff --git "a/{quoted}" "b/{quoted}"',
                                  f'--- "a/{quoted}"', f'+++ "b/{quoted}"',
                                  "@@ -1 +1 @@", "-old", "+new"])
                node = json.loads(packet([]))
                node["diff"] = diff
                node["files"] = [{"filename": retained, "status": "modified",
                                  "old_mode": "100644", "new_mode": "100644"}]
                self.assertEqual(review_stages.split(json.dumps(node)), [json.dumps(node)])

    def test_quoted_deletion_matches_its_old_path(self):
        diff = "\n".join(['diff --git "a/we\\"ird.py" "b/we\\"ird.py"',
                          '--- "a/we\\"ird.py"', "+++ /dev/null",
                          "@@ -1 +0,0 @@", "-gone"])
        sets = review_stages.diff_line_sets(diff, ['we"ird.py'])
        self.assertEqual(sets['we"ird.py']["left"], {1})

    def test_quoted_pure_rename_matches_both_sides(self):
        diff = "\n".join(['diff --git "a/o\\"ld.py" "b/n\\"ew.py"',
                          "similarity index 100%",
                          'rename from "o\\"ld.py"',
                          'rename to "n\\"ew.py"'])
        node = json.loads(packet([]))
        node["diff"] = diff
        node["files"] = [{"filename": name, "status": status,
                          "old_mode": "100644", "new_mode": "100644"}
                         for name, status in (('o"ld.py', "removed"), ('n"ew.py', "added"))]
        self.assertEqual(review_stages.split(json.dumps(node)), [json.dumps(node)])

    def test_unquoted_quote_wrapped_path_prefers_the_raw_match(self):
        # With quoting disabled a literal quote-wrapped name still matches raw.
        diff = "\n".join(['diff --git a/"q.py" b/"q.py"',
                          '--- a/"q.py"', '+++ b/"q.py"',
                          "@@ -1 +1 @@", "-old", "+new"])
        sets = review_stages.diff_line_sets(diff, ['"q.py"'])
        self.assertEqual(sets['"q.py"']["right"], {1})

    def test_mode_only_section_matches_longest_retained_path(self):
        # A mode-only section for "x b/y" must not be attributed to the
        # retained suffix "y", which would leave "x b/y" uncovered.
        node = json.loads(packet([]))
        node["diff"] = "\n".join(["diff --git a/x b/y b/x b/y", "old mode 100644", "new mode 100755",
                                  "diff --git a/y b/y", "old mode 100644", "new mode 100755"])
        node["files"] = [{"filename": name, "status": "modified",
                          "old_mode": "100644", "new_mode": "100755"} for name in ("y", "x b/y")]
        stages = review_stages.split(json.dumps(node))
        self.assertEqual(len(stages), 1)
        self.assertEqual(json.loads(stages[0])["diff"].count("new mode"), 2)

    def test_pure_rename_prefers_its_rename_to_path(self):
        # A pure rename "q b/y" -> "z" next to a retained "y b/z": the
        # header "diff --git a/q b/y b/z" must resolve to the rename
        # target "z", not the retained suffix "y b/z".
        node = json.loads(packet([]))
        node["diff"] = "\n".join(["diff --git a/q b/y b/z", "similarity index 90%",
                                  "rename from q b/y", "rename to z",
                                  section("y b/z")])
        node["files"] = [{"filename": name, "status": status,
                          "old_mode": "100644", "new_mode": "100644"}
                         for name, status in (("q b/y", "removed"), ("z", "added"),
                                              ("y b/z", "modified"))]
        stages = review_stages.split(json.dumps(node))
        self.assertEqual(len(stages), 1)

    def test_quoted_rename_to_prefers_the_decoded_destination(self):
        # A quoted "rename to" value decodes to the rename destination
        # even when the raw quoted value is another retained file's
        # literal name.
        diff = "\n".join(['diff --git "a/o\\"ld.py" "b/n\\"ew.py"',
                          "similarity index 100%",
                          'rename from "o\\"ld.py"',
                          'rename to "n\\"ew.py"'])
        sets = review_stages.diff_line_sets(diff, ['o"ld.py', 'n"ew.py', '"n\\"ew.py"'])
        self.assertIn('n"ew.py', sets)

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

    def test_diff_line_sets_split_hunks_by_side(self):
        diff = "\n".join([
            "diff --git a/src/a.py b/src/a.py",
            "--- a/src/a.py", "+++ b/src/a.py",
            "@@ -10,4 +10,4 @@",
            " ctx1", "-old1", "+new1", " ctx2",
            "diff --git a/src/gone.py b/src/gone.py",
            "--- a/src/gone.py", "+++ /dev/null",
            "@@ -1,2 +0,0 @@",
            "-line1", "-line2",
        ])
        sets = review_stages.diff_line_sets(diff, ["src/a.py", "src/gone.py"])
        self.assertEqual(sets["src/a.py"]["left"], {10, 11, 12})
        self.assertEqual(sets["src/a.py"]["right"], {10, 11, 12})
        self.assertEqual(sets["src/gone.py"]["left"], {1, 2})
        self.assertEqual(sets["src/gone.py"]["right"], set())

    def test_diff_left_anchors_maps_left_lines_to_current_position_and_content(self):
        diff = "\n".join([
            "diff --git a/src/a.py b/src/a.py",
            "--- a/src/a.py", "+++ b/src/a.py",
            "@@ -10,4 +10,4 @@",
            " ctx1", "-old1", "+new1", " ctx2",
        ])
        contents = review_stages.diff_left_anchors(diff, ["src/a.py"])
        self.assertEqual(contents["src/a.py"], {10: (10, "ctx1"), 11: (11, "old1"), 12: (12, "ctx2")})

    def test_malformed_hunk_header_fails_loud(self):
        diff = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ bogus @@\n-x\n"
        with self.assertRaises(review_stages.StageError):
            review_stages.diff_line_sets(diff, ["f"])

    def test_bounded_packet_keeps_its_omitted_files_in_every_stage(self):
        paths = [f"src/f{i:02d}.py" for i in range(9)]
        raw = packet(paths, omitted_files=[{"path": "src/rest.py", "reason": "omitted"}])
        stages = review_stages.split(raw)
        self.assertEqual(len(stages), 2)
        for stage in stages:
            node = json.loads(stage)
            self.assertEqual(node["omitted_files"], [{"path": "src/rest.py", "reason": "omitted"}])
            self.assertIn("not reviewed in any stage", node["review_scope"])
