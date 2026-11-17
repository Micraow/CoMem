"""Register the OpenUI authoring skill with the Hermes agent."""

from pathlib import Path


def register(ctx) -> None:
    """Expose the bundled skill as ``hermes-openui:openui``."""
    ctx.register_skill(
        "openui",
        Path(__file__).resolve().parent / "skills" / "openui" / "SKILL.md",
        "Create a progressive, locally interactive OpenUI answer for comparisons, calculators, data views, diagrams, maps, and other results that work better than prose alone.",
    )
