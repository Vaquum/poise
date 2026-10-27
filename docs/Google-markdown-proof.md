# Google Markdown compatibility proof

Live provider checks performed on 2026-10-20 using a private disposable file,
through the connected Google Drive API and the Google Docs web editor. This
is a compatibility sample, not proof of every Google API guarantee.

| Check | Observed result |
| --- | --- |
| Upload `text/markdown`, read it, replace its raw bytes | Same Drive file ID; exact content readback |
| Add two quoted Drive API comments, then update the file | Drive comments survive; neither has a native text anchor |
| Add a native text-anchored comment in Docs | Raw `.md` acquires begin/end markers and a trailing `gdoc_comments` block |
| Read Drive comments after adding the native comment | Native comment absent; only the two Drive API comments returned |
| Read the Markdown file with Docs API `documents.get` | Content and revision ID returned |
| Update it with Docs API `documents.batchUpdate` | HTTP 400 `FAILED_PRECONDITION`: document must not be an Office file |
| Preserve native markers/block, change another paragraph and insert text before the anchor, then update raw file | Reopened Docs retains the anchored comment; exact 912-byte raw readback |
| Replace with plain Markdown containing the same quoted passage | Native thread becomes inactive, labelled “Original content deleted” |
| Add a native reply, then resolve the thread | Raw metadata retains reply text and a bodyless `action: RESOLVE` event; root status becomes `RESOLVED`; markers remain |

The recorded provider shape, with identity and token redacted:

```markdown
<!-- gdoc_comment_begin: c1 -->The silver owl circles the<!-- gdoc_comment_end: c1 --> old tower.

---
gdoc_comments:
  c1:
    status: RESOLVED
    token: REDACTED
    head:
      author: Reviewer
      body: Native Google Docs proof comment.
      quote: ''
    replies:
    - author: Reviewer
      body: Disposable Poise proof reply.
    - author: Reviewer
      action: RESOLVE
---
```

Regression fixtures in `tests/google-markdown.test.ts` use this observed shape
with redacted identity/token fields. Opaque metadata is preserved verbatim;
Poise exposes only safe comment text and locations to the browser. Unknown or
broken structures stop publication. Editing a commented passage or losing its
unambiguous identity also stops publication.

## Live conditional-write proof

Real Poise OAuth succeeded through the loopback proof workspace with the
`openid email drive.file` scopes. Drive v3 metadata returned HTTP 200 without
an ETag, so the original adapter correctly refused publication.

Drive v2 returned a strong metadata ETag. A fresh conditional media `PUT`
succeeded; a subsequent stale `PUT` returned HTTP 412, and an independent read
confirmed that the exact newer bytes survived. These were disposable real
files using the app's OAuth grant, not mocked HTTP responses.

The metadata ETag also returned 412 on a fresh media GET, so it cannot pin
downloads. The adapter checks v2 metadata before and after downloading and
refuses a changed ETag. Updates use the same validator in a conditional v2
media PUT; the read checks do not substitute for that atomic write condition.

The native-comment concurrency proof also passed: after capturing an anchored
comment, a newer reply was posted in Google Docs. The old conditional upload
was rejected and the exact newer raw file, anchor and reply survived. Poise
displayed the thread and reply. An uncommented paragraph was then edited in
Poise and published to the same file; reopening Google Docs verified the new
text and retained native discussion.

A direct Google edit appeared as Updates available without changing the local
draft. Explicit review/import brought that edit into Poise and retained an
exact copy of the prior local text in Google history. Provider metadata was
absent from the imported draft.

Two real identities connected through Settings and published the same local
draft to distinct private files. Publishing a subsequent edit through the
second account changed only its file; the first remained byte-for-byte
unchanged. Reading either file with the other account returned 404. Both
publication bindings retained their original file IDs.

Actual OAuth through the service gateway remains unproved. This is a release
blocker tracked in
[#258](https://github.com/autonomio/poise/issues/258). Missing, weak or unusable
validators refuse mutation.

Google documents the underlying file-format capability in
[View and edit Markdown files in Google Docs](https://support.google.com/docs/answer/18289341?hl=en).
The API primitives are documented in
[Drive v2 File](https://developers.google.com/workspace/drive/api/reference/rest/v2/files)
and [files.update](https://developers.google.com/workspace/drive/api/reference/rest/v2/files/update).
