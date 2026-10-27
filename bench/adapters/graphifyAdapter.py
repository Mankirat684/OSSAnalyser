#!/usr/bin/env python3
"""
Graphify Benchmark Adapter for Crosstool Evaluation.
Exposes Graphify's query_graph API to the benchmark agent.
"""
import sys
import json
from pathlib import Path
from graphify.serve import _read_graph, _query_graph_text

_cached_graphs = {}

def get_graph(graph_path: str):
    p = str(Path(graph_path).resolve())
    if p not in _cached_graphs:
        _cached_graphs[p] = _read_graph(p)
    return _cached_graphs[p]

def query_graphify(graph_path: str, question: str, mode: str = "bfs", depth: int = 3, token_budget: int = 2000) -> str:
    try:
        G = get_graph(graph_path)
        result = _query_graph_text(G, question, mode=mode, depth=depth, token_budget=token_budget)
        return result
    except Exception as e:
        return f"Error executing query_graph: {str(e)}"

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: python graphifyAdapter.py <graph_path> <question> [budget] [mode]"}))
        sys.exit(1)

    graph_path = sys.argv[1]
    question = sys.argv[2]
    budget = int(sys.argv[3]) if len(sys.argv) > 3 else 2000
    mode = sys.argv[4] if len(sys.argv) > 4 else "bfs"

    output = query_graphify(graph_path, question, mode=mode, depth=3, token_budget=budget)
    print(output)
