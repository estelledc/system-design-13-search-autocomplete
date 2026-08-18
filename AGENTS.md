# Repository instructions

- Treat this as an evidence-first search-autocomplete practice, not a production search engine.
- Keep event acceptance, aggregate eligibility, snapshot publication, suggestion response, client rendering, and user selection separate.
- Preserve the immutable closed-book contract; record later corrections in the research log or an ADR.
- Use synthetic queries only. Do not log raw query text, idempotency keys, actor identities, or request prefixes.
- Do not add a cache, stream processor, or distributed trie until a tested invariant requires it.
- Do not copy unlicensed upstream prose, diagrams, images, or code.
