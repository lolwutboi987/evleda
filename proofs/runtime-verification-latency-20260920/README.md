# Runtime verification latency experiment: not adopted

The four-reader runtime verifier took a mean **10.35 s** across three checks of
the actual 8,469-file DOC17 runtime. An eight-reader experiment took **7.37 s**,
about **28.8% lower**, while preserving every ancestor, descriptor, content,
identity and deadline check. These are local observations, not speed guarantees.
The instrumented operation profile is separate because its measurement overhead
increased execution time. [Before](baseline.json), [experiment](concurrency8.json),
and [operation counts](operation-profile.json) retain the measurements.

The candidate passed **204 runtime/profile tests**, source typecheck and backend
build. However, actual native startup failed at session-authority binding after
editor readiness, and cleanup was not confirmed. The categorical diagnostic
does not identify the exact guard, so the failure cannot confidently be attributed
to scheduling. That uncertainty prevents shipping the change.

The source edit was reverted and the installed host50/DOC17 entry remains
unchanged. All six PCB sources match the published candidate. The failed
allocation and its lease are preserved. The [outcome](qualification-outcome.json)
and [rejected patch](rejected-scheduler.patch) record the distinction between
the software/benchmark result and failed native qualification. The existing public source-preserving revision operation restored a managed copy
under host50/DOC17: **17b88ed0-adea-4634-a468-8d417dc16c97**. All six native files match the
published candidate, and both source and target closed normally. The failed
allocation is not cleared or relabelled. [Restoration evidence](managed-restoration.json)
records the new project ID; no previous live fill or acceptance authority transfers.
