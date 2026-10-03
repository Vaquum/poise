import os
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException

from .interface import UnknownBehavior, approve_pr, assign_issue, checkout_pr_head, comment_issue, commit_work, create_issue, create_pr_linked_issue, current_pr, edit_issue_comment, head_sha, list_failing_ci, list_test_files, local_checkout_path, mergeable, post_pr_comment, pr_readiness, pr_review, read_failing_ci_log, read_file, read_issue, request_changes, requested_changes_addressed, requested_review_ready, reviewed_clean, review_activity_since, resolve_conversation, resolve_nonblocking_conversations_if_ready, resolve_pr_conversations, run_behavior, view_repos, write_file

app = FastAPI()


@app.post("/behaviors/{name}")
async def behavior(name: str, payload: dict[str, Any]) -> Any:
    try:
        return await run_behavior(name, payload)
    except UnknownBehavior as error:
        raise HTTPException(status_code=404, detail=f"Unknown behavior: {name}") from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/pr_review")
async def review(payload: dict[str, Any]) -> Any:
    try:
        return await pr_review(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/approve_pr")
async def approval(payload: dict[str, Any]) -> Any:
    try:
        return await approve_pr(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/head_sha")
async def pr_head_sha(payload: dict[str, Any]) -> Any:
    try:
        return await head_sha(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/list_failing_ci")
async def failing_ci(payload: dict[str, Any]) -> Any:
    try:
        return await list_failing_ci(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/read_failing_ci_log")
async def failing_ci_log(payload: dict[str, Any]) -> Any:
    try:
        return await read_failing_ci_log(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/checkout_pr_head")
async def pr_head_checkout(payload: dict[str, Any]) -> Any:
    try:
        return await checkout_pr_head(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/commit_work")
async def work_commit(payload: dict[str, Any]) -> Any:
    try:
        return await commit_work(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/list_test_files")
async def test_files_list(payload: dict[str, Any]) -> Any:
    try:
        return await list_test_files(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/read_file")
async def file_read(payload: dict[str, Any]) -> Any:
    try:
        return await read_file(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/write_file")
async def file_write(payload: dict[str, Any]) -> Any:
    try:
        return await write_file(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/create_issue")
async def issue(payload: dict[str, Any]) -> Any:
    try:
        return await create_issue(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/create_pr_linked_issue")
async def pr_issue(payload: dict[str, Any]) -> Any:
    try:
        return await create_pr_linked_issue(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/request_changes")
async def changes(payload: dict[str, Any]) -> Any:
    try:
        return await request_changes(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/reviewed_clean")
async def clean_review(payload: dict[str, Any]) -> Any:
    try:
        return await reviewed_clean(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/requested_changes_addressed")
async def changes_addressed(payload: dict[str, Any]) -> Any:
    try:
        return await requested_changes_addressed(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/requested_review_ready")
async def review_ready(payload: dict[str, Any]) -> Any:
    try:
        return await requested_review_ready(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/review_activity_since")
async def review_activity(payload: dict[str, Any]) -> Any:
    try:
        return await review_activity_since(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/resolve_conversation")
async def conversation_resolve(payload: dict[str, Any]) -> Any:
    try:
        return await resolve_conversation(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/resolve_pr_conversations")
async def pr_conversations_resolve(payload: dict[str, Any]) -> Any:
    try:
        return await resolve_pr_conversations(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/resolve_nonblocking_conversations_if_ready")
async def nonblocking_conversations_resolve(payload: dict[str, Any]) -> Any:
    try:
        return await resolve_nonblocking_conversations_if_ready(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/mergeable")
async def merge(payload: dict[str, Any]) -> Any:
    try:
        return await mergeable(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/current_pr")
async def current_pull(payload: dict[str, Any]) -> Any:
    try:
        return await current_pr(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/pr_readiness")
async def pull_readiness(payload: dict[str, Any]) -> Any:
    try:
        return await pr_readiness(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/post_pr_comment")
async def pr_comment(payload: dict[str, Any]) -> Any:
    try:
        return await post_pr_comment(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/local_checkout_path")
async def checkout(payload: dict[str, Any]) -> Any:
    try:
        return await local_checkout_path(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/view_repos")
async def repos(payload: dict[str, Any]) -> Any:
    try:
        return await view_repos(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/read_issue")
async def issue_read(payload: dict[str, Any]) -> Any:
    try:
        return await read_issue(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/assign_issue")
async def issue_assign(payload: dict[str, Any]) -> Any:
    try:
        return await assign_issue(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/comment_issue")
async def issue_comment(payload: dict[str, Any]) -> Any:
    try:
        return await comment_issue(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/edit_issue_comment")
async def issue_comment_edit(payload: dict[str, Any]) -> Any:
    try:
        return await edit_issue_comment(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


def main() -> None:
    port = int(os.environ.get("GITHUB_INTERFACE_PORT", "8001"))
    uvicorn.run("github_interface.api:app", host="127.0.0.1", port=port)


if __name__ == "__main__":
    main()
