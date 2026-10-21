# Agent Trace Explorer

Local read-only viewer for the Agent Trajectories JSONL release. Requires Python 3.9+ and no third-party packages.

```bash
python3 server.py --dataset /Users/cc/DataSet/agent_trajectories --port 8765
```

Open http://127.0.0.1:8765 after indexing completes. The server binds only to localhost. It scans each JSONL once at startup and stores byte offsets and metadata in memory; individual full records are read on demand. The dataset is never modified.

The timeline follows `messages`, links tool results to calls by `tool_call_id`, and preserves unmatched calls/results visibly. `trace_meta` is available in the details panel without assuming its steps are aligned with messages. MCP rewards are continuous and are not marked as binary success/failure. SVG export contains a compact overview, not full message contents.

Interaction references: https://github.com/AR-FORUM/hodoscope and https://github.com/Slimshilin/ATIF-trajectory-viewer. No code from these projects is included.
