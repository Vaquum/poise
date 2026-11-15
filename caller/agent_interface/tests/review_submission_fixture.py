from pathlib import Path


def submission_args(args):
    """Capture the comments while the submission still owns its file."""
    if "--comments" not in args:
        return args
    position = args.index("--comments") + 1
    return [*args[:position], Path(args[position]).read_text(encoding="ascii"), *args[position + 1:]]
