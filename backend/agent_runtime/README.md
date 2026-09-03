# Schema-bound agent runtime

This package turns one immutable orchestration task into one proposal-only model turn.

The OpenAI provider uses the Responses API with strict JSON Schema output and does not send an
application `max_output_tokens` limit. Provider and model limits still apply. The API key is read
only from `OPENAI_API_KEY` or supplied by the host and is never persisted in a proposal or trace.

The host validates every response again. A proposal is rejected if it changes the context digest,
requests an unauthorized capability/action, cites missing evidence, contains floating point or
escape-hatch parameters, has a cyclic task DAG, or combines a blocking question with design
operations. Model output never represents approval, execution, verification, release, or safety.
