# Publishing

Write in the Editor, then publish the document as a pull request to websites
kept in GitHub repositories: one site, or several at once. Nothing reaches a
site until its maintainers merge the pull request. Publishing works with any
site whose posts are files in a repository (Astro, Hugo, Jekyll, Eleventy and
the like), because each site says how it takes a post in a `publish.yaml` at
the root of its repository.

## A site's publish.yaml

mikkokotila.com's, for example:

```yaml
# How a writing tool publishes to mikkokotila.com: a piece becomes one file, proposed as a pull request.
version: 1
site: mikkokotila.com
sections:
  - name: Writing
    path: src/content/writing/{slug}.md
    url: https://mikkokotila.com/writing/{slug}/
    slug: "^[a-z0-9]+(?:-[a-z0-9]+)*$"
    first_line: title
    fields:
      type:        { kind: choice, choices: [essay, note], default: essay }
      title:       { kind: text, required: true, max: 220 }
      description: { kind: text, lines: many, max: 420 }
      date:        { kind: date, required: true, default: today }
      origins:     { kind: places, self: { venue: mikkokotila.com }, item: { venue: "{site}", url: "{url}" } }
      tags:        { kind: list, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", suggest: "content/writing.yaml#topics[].tag" }
```

- `version` is 1.
- `site` is the name the Editor shows, and the name other sites use for this
  one when a piece is published on both.
- `branch` (optional) is the branch pull requests go to. Without it, the
  repository's default branch.
- `sections` lists the kinds of page the site takes, one to twenty, each with
  a name of its own:
  - `path` is where the file goes, and must contain `{slug}`. `path` and `url`
    can use `{slug}`, `{date}`, `{year}`, `{month}` and `{day}`; the date is
    the section's first date field, or today.
  - `url` (optional) is the page's address once published.
  - `slug` is a regular expression the slug must match. The Editor suggests
    a slug from the title: lowercase words joined by hyphens.
  - `first_line` (optional) names the text field the document's first line
    fills; the post's text starts after that line. Without it, the whole
    document is the text.
  - `fields` become the post's frontmatter, in the order listed.

| Kind | What it holds | Options |
| --- | --- | --- |
| `text` | One line, or several with `lines: many` | `max` characters, `pattern` |
| `choice` | One of `choices` | `choices` (required) |
| `list` | Several words, typed separated by commas | `max` words, `pattern` for each, `suggest` |
| `date` | A date, `YYYY-MM-DD` | `default: today` |
| `boolean` | True or false | |
| `places` | Where the piece is published, the original first; filled in by Poise | `item` (required), `self` |
| `canonical` | The original's address, written only on the copies; filled in by Poise | |

The first five also take `label`, `required`, `default`, or `value`: a fixed
value that is always written and never shown. `suggest` names a file in the
repository and a path in it, like `content/writing.yaml#topics[].tag`, and the
Editor offers its words. A `places` field writes one entry per site the piece
is on, from `item`, a template or keys with templates using `{site}` and
`{url}`; `self` is this site's own entry. An empty value leaves its key out.

Strings in the frontmatter are written quoted, so a date stays text for YAML
1.1 readers too. A description with an unknown key, a missing part or a
pattern that is not a regular expression is refused, and the message names
the key. A description is at most 64 KB.

## Settings → Publishing

Settings → Publishing lists your sites, one row each: its name, its
repository, and Ready or what is wrong with its description. Add a site by
`owner/repository` or its GitHub address. A repository without `publish.yaml`
can be described here instead: Describe opens a box with a starting
description to edit, kept in Poise. A description is saved only when it
reads; until then the box keeps the text and shows the error. Remove asks
once more. Sites are read as your GitHub account (Settings → General), which
must be set, and signed in to `gh`.

## Publishing from the Editor

The Publish icon in the Editor bar opens the panel for the open document:

- the ready sites (and their sections, when a site has several), to choose
  from; a site the document is published on shows its pull request and its
  state, and is chosen already, as is the only site when there is one;
- Title, Description and Date, asked once. Title fills each section's
  `first_line` field, or its text field named `title`; Description its text
  field named `description`; Date its first date field. The title starts as
  the document's first line;
- each chosen site's own fields and its slug. The slug follows the title until
  you type one, and stays as it was once the piece is published there (a
  pull request closed unmerged does not count). A required choice with no
  default asks for one;
- one button: Publish, or Update when every chosen site has the piece.

Publishing saves the document first. Every site's values are checked before
anything is written, and a site whose values are refused, or that then fails,
is named on no other site: a file already published that named it is
published again without it. For each site, Poise builds the file
(YAML frontmatter, then the text), creates a branch `publish/<slug>` from the
site's branch, commits the file with GitHub's GraphQL `createCommitOnBranch`,
and opens a pull request. Everything is done as your own GitHub account,
with the token `gh` holds for it, never the automation account. A repository
you cannot push to gets the pull request from your fork, which Poise makes
when there is none. Each site's result shows under it: its pull request, or
what is wrong.

### Publishing again

- While the pull request is open, publishing again commits to its branch. If
  it is merged or closed meanwhile, that commit gets a pull request of its own.
- Once it is merged, an update gets a pull request of its own, `Update: <title>`.
- A pull request closed unmerged left nothing new on the site. A version
  merged before it stays the document's, and the next publish updates it;
  with none, the next publish is a first one again, and until then no other
  site names it.
- Changes made on the site (a field, or the text) are kept, at every later
  publication. The same field, or the text, changed both on the site and in
  the document is refused and named; Replace with mine publishes the
  document's version.
- A section without a date field keeps the date of its first publication in
  its path and address.
- When the site has this version already, nothing is committed.
- A file the document did not publish is never written over: choose another
  slug. A file on the site whose frontmatter cannot be read is reported for
  that site, and the other sites are still published.

Each document's publications are kept beside it as `<slug>.publish.json` in
the Editor folder: the site, path, branch and pull request, and what was
published. Deleting the document deletes it; the pull requests stay.

## Limits

- Images are not published yet: the Editor holds none.
- Only sites in GitHub repositories.
- Up to ten sites at once, and a document's record of where it is published
  stays under 1 MB: a publication that would pass it is refused before
  anything is written.
- One publication at a time across the Poise processes sharing an Editor
  folder. None starts while Poise installs an update, and an update waits
  for one in progress.
- A site's patterns are checked with a time limit of 50 ms, since a
  description comes from a repository.
