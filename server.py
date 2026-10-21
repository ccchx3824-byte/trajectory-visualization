#!/usr/bin/env python3
"""Local, read-only browser for the Agent Trajectories JSONL release."""
import argparse
import json
import mimetypes
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
DATASET = Path('/Users/cc/DataSet/agent_trajectories')
BENCHMARKS = ('tau2bench', 'swebench', 'terminalbench', 'mathhay', 'search', 'mcpbench')
INDEX = []
BY_ID = {}


def build_index(dataset):
    for benchmark in BENCHMARKS:
        path = dataset / f'{benchmark}.jsonl'
        if not path.is_file():
            continue
        with path.open('rb') as stream:
            while True:
                offset = stream.tell()
                line = stream.readline()
                if not line:
                    break
                record = json.loads(line)
                item = {key: record.get(key) for key in ('id', 'benchmark', 'domain', 'task_id', 'source_model', 'pass', 'reward', 'num_turns', 'has_all_4_passes')}
                item['tool_calls'] = sum(len(m.get('tool_calls') or []) for m in record.get('messages', []))
                item['_path'], item['_offset'] = path, offset
                INDEX.append(item)
                BY_ID[item['id']] = item
        print(f'Indexed {benchmark}', flush=True)


def public(item):
    return {key: value for key, value in item.items() if not key.startswith('_')}


class Handler(BaseHTTPRequestHandler):
    def respond(self, status, body, content_type):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, value, status=200):
        self.respond(status, json.dumps(value, ensure_ascii=False).encode(), 'application/json; charset=utf-8')

    def do_GET(self):
        url = urlparse(self.path)
        params = parse_qs(url.query)
        if url.path == '/api/records':
            query = params.get('q', [''])[0].lower().strip()
            benchmark = params.get('benchmark', [''])[0]
            model = params.get('model', [''])[0]
            result = params.get('result', [''])[0]
            try:
                page = max(1, int(params.get('page', ['1'])[0]))
            except ValueError:
                return self.send_json({'error': 'Invalid page'}, 400)
            def matches(item):
                if benchmark and item['benchmark'] != benchmark: return False
                if model and item['source_model'] != model: return False
                if result == 'success' and (item['benchmark'] == 'mcpbench' or item['reward'] != 1): return False
                if result == 'failure' and (item['benchmark'] == 'mcpbench' or item['reward'] != 0): return False
                if result == 'continuous' and item['benchmark'] != 'mcpbench': return False
                return not query or query in ' '.join(str(item.get(k) or '') for k in ('id', 'domain', 'task_id', 'source_model')).lower()
            matches_list = [item for item in INDEX if matches(item)]
            size = 12
            return self.send_json({'total': len(matches_list), 'page': page, 'page_size': size, 'records': [public(x) for x in matches_list[(page-1)*size:page*size]], 'benchmarks': dict(Counter(x['benchmark'] for x in INDEX)), 'models': sorted({x['source_model'] for x in INDEX})})
        if url.path == '/api/record':
            item = BY_ID.get(params.get('id', [''])[0])
            if item is None: return self.send_json({'error': 'Record not found'}, 404)
            with item['_path'].open('rb') as stream:
                stream.seek(item['_offset'])
                return self.send_json(json.loads(stream.readline()))
        files = {'/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/overrides.css': 'overrides.css'}
        if url.path not in files: return self.send_json({'error': 'Not found'}, 404)
        path = ROOT / 'static' / files[url.path]
        return self.respond(200, path.read_bytes(), (mimetypes.guess_type(path.name)[0] or 'application/octet-stream') + '; charset=utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--dataset', type=Path, default=DATASET)
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    build_index(args.dataset)
    print(f'{len(INDEX)} trajectories indexed. Open http://127.0.0.1:{args.port}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
