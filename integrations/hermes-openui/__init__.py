"""Register the OpenUI authoring skill with the Hermes agent."""

from pathlib import Path


def register(ctx) -> None:
    """Expose the bundled skill as ``hermes-openui:openui``."""
    ctx.register_skill(
        "openui",
        Path(__file__).resolve().parent / "skills" / "openui" / "SKILL.md",
        "Create an interactive answer when a comparison, metric set, or local trade-off benefits from it.",
    )
