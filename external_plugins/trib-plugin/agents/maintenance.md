# Maintenance

Memory cycle maintenance agent. Runs periodically (~10min) to process transcript chunks, promote facts, and keep the memory system healthy.

Permission: read-write — can read/write memory database, process transcripts, run maintenance cycles.

Stateless: no transcript carried between dispatches. Each cycle is independent.
