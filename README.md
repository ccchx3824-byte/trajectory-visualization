# Agent Trace Explorer

Local read-only viewer for the Agent Trajectories JSONL release. Requires Python 3.9+ and no third-party packages.

```bash
python3 server.py --dataset /Users/cc/DataSet/agent_trajectories --port 8765
```

Open http://127.0.0.1:8765 after indexing completes. The server binds only to localhost. It scans each JSONL once at startup and stores byte offsets and metadata in memory; individual full records are read on demand. The dataset is never modified.

The timeline follows `messages`, links tool results to calls by `tool_call_id`, and preserves unmatched calls/results visibly. `trace_meta` is available in the details panel without assuming its steps are aligned with messages. MCP rewards are continuous and are not marked as binary success/failure. SVG export contains a compact overview, not full message contents.

## Same-task comparison

Select a trajectory, then click `对比本任务`. The picker lists every retained trajectory with the same `(benchmark, domain, task_id)`, including other source models and independent passes. It defaults to all passes for the selected model, but any combination of two or more trajectories can be selected.

The overlay visualizes selected trajectories as parallel columns and aligns them by message number. A red `Delta` marker and red card border indicate that the selected trajectories differ at that message number in role, tool-call name, message content summary, or whether the trajectory has already ended. Click a comparison card to inspect its full saved message.

## AI evaluation analysis

Use `AI 设置` to configure an OpenAI-compatible gateway: Base URL, API Key, and model name. The server accepts either a base ending in `/v1` or a complete `/chat/completions` endpoint. The API Key stays only in the browser's current memory; it is not written to the repository, configuration file, or browser storage. Base URL and model name are kept in session storage only for the current browser session.

On a single-trajectory view, choose `AI 分析评测原因`. The local server reads the selected record on demand and sends a bounded digest of the trajectory, tool interactions, and evaluation metadata to the configured provider. The prompt asks the model to separate evaluator facts from inferred causes and to cite trajectory step numbers. Long message content is truncated, and the complete trajectory digest has a 65,000-character budget.

In a comparison view, select exactly two trajectories and choose `AI 分析差异`. It compares evaluator outcomes, identifies the mechanically detected first different message, then asks the model to distinguish that first divergence from the evidence-supported outcome-critical divergence. The analysis is cached for the current browser session by trajectory pair, provider URL, and model.

Interaction references: https://github.com/AR-FORUM/hodoscope and https://github.com/Slimshilin/ATIF-trajectory-viewer. No code from these projects is included.
