"""Normalize repository-relative target selectors."""


def normalize_targets(targets: list[str]) -> list[str]:
    """Return normalized targets.

    The current implementation is intentionally incomplete for the evaluation
    task: it loses caller order and accepts unsafe path forms.
    """

    return sorted({target.strip() for target in targets if target.strip()})
