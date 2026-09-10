# Example prompts

- `reference-controller-v0.txt` is fully specified for the initial supported profile and should reach requirements review without an ambiguity blocker.
- `ambiguous-voltage.txt` must block in `requirements`; the engine may not select a voltage for the user.
- `impossible-current-budget.txt` must block before architecture completion because the declared source budget is below the aggregate motor requirement even before logic losses.

These fixtures exercise workflow behavior. They are not electrical qualification evidence.

