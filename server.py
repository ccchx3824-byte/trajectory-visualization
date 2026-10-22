#!/usr/bin/env python3
"""Local, read-only browser for the Agent Trajectories JSONL release."""
import argparse
import json
import mimetypes
import urllib.error
import urllib.request
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


def load_record(item):
    with item['_path'].open('rb') as stream:
        stream.seek(item['_offset'])
        return json.loads(stream.readline())


def clipped(value, limit):
    text = str(value or '').replace('\x00', '')
    return text if len(text) <= limit else text[:limit] + '\n...[truncated]'


def trajectory_digest(record, budget=65000):
    """Create a bounded, evaluation-oriented representation for external analysis."""
    messages = []
    remaining = budget
    for index, message in enumerate(record.get('messages', [])):
        tools = [call.get('function', {}).get('name', '') for call in message.get('tool_calls', [])]
        content_limit = min(1800 if message.get('role') in ('assistant', 'tool') else 900, max(0, remaining))
        content = clipped(message.get('content'), content_limit) if content_limit else '[omitted after trajectory budget]'
        remaining -= len(content)
        messages.append({
            'step': index + 1,
            'role': message.get('role'),
            'tool_calls': tools,
            'tool_call_id': message.get('tool_call_id'),
            'content': content,
        })
    detail = record.get('eval_details', {})
    evaluation = {
        'reward': record.get('reward'),
        'benchmark': record.get('benchmark'),
        'task_id': record.get('task_id'),
        'status': detail.get('status'),
        'resolved': detail.get('resolved'),
        'test_passed': detail.get('test_passed'),
        'note': clipped(detail.get('note'), 1000),
        'test_output': clipped(detail.get('test_output'), 2400),
        'predicted_answer': detail.get('predicted_answer'),
        'golden_answer': detail.get('golden_answer'),
        'numerical_match': detail.get('numerical_match'),
        'llm_judge': detail.get('llm_judge'),
        'search_score': detail.get('score'),
        'reward_info': detail.get('reward_info'),
        'mcp_evaluation': detail.get('evaluation'),
    }
    return {
        'trajectory': {key: record.get(key) for key in ('id', 'benchmark', 'domain', 'task_id', 'source_model', 'pass', 'num_turns', 'reward')},
        'evaluation': evaluation,
        'messages': messages,
    }


def message_signature(message):
    if message is None:
        return 'missing'
    tools = ','.join(call.get('function', {}).get('name', '') for call in message.get('tool_calls') or [])
    content = ' '.join(str(message.get('content') or '').split())[:400]
    return f"{message.get('role')}|{tools}|{content}"


def message_category(left, right):
    message = left or right or {}
    role = message.get('role')
    if role == 'user':
        return 'external_input'
    if role == 'assistant':
        return 'agent_decision'
    if role == 'tool':
        return 'environment_result'
    return 'system_context'


def alignment_score(left, right):
    if left is None or right is None:
        return -3
    if left.get('role') != right.get('role'):
        return -5
    score = 2
    left_tools = [call.get('function', {}).get('name', '') for call in left.get('tool_calls') or []]
    right_tools = [call.get('function', {}).get('name', '') for call in right.get('tool_calls') or []]
    if left_tools or right_tools:
        score += 5 if left_tools == right_tools else -2
    if left.get('role') == 'tool':
        score += 4 if left.get('name') == right.get('name') else -2
    left_content = ' '.join(str(left.get('content') or '').split())[:400]
    right_content = ' '.join(str(right.get('content') or '').split())[:400]
    if left_content == right_content:
        score += 4
    elif left_content and right_content:
        left_words, right_words = set(left_content.lower().split()), set(right_content.lower().split())
        overlap = len(left_words & right_words) / max(1, len(left_words | right_words))
        score += 2 if overlap >= .5 else 1 if overlap >= .2 else 0
    return score


def align_messages(left_messages, right_messages):
    """Needleman-Wunsch alignment prevents inserted turns from shifting all later comparisons."""
    rows, columns, gap = len(left_messages), len(right_messages), -3
    scores = [[0] * (columns + 1) for _ in range(rows + 1)]
    moves = [[None] * (columns + 1) for _ in range(rows + 1)]
    for row in range(1, rows + 1):
        scores[row][0], moves[row][0] = scores[row - 1][0] + gap, 'up'
    for column in range(1, columns + 1):
        scores[0][column], moves[0][column] = scores[0][column - 1] + gap, 'left'
    for row in range(1, rows + 1):
        for column in range(1, columns + 1):
            options = (
                (scores[row - 1][column - 1] + alignment_score(left_messages[row - 1], right_messages[column - 1]), 'diag'),
                (scores[row - 1][column] + gap, 'up'),
                (scores[row][column - 1] + gap, 'left'),
            )
            scores[row][column], moves[row][column] = max(options, key=lambda option: option[0])
    aligned = []
    row, column = rows, columns
    while row or column:
        move = moves[row][column]
        if move == 'diag':
            aligned.append((row - 1, column - 1)); row -= 1; column -= 1
        elif move == 'up':
            aligned.append((row - 1, None)); row -= 1
        else:
            aligned.append((None, column - 1)); column -= 1
    return list(reversed(aligned))


def comparison_digest(records):
    left_messages, right_messages = records[0].get('messages', []), records[1].get('messages', [])
    aligned = align_messages(left_messages, right_messages)
    differences = []
    for aligned_row, (left_index, right_index) in enumerate(aligned, start=1):
        left = left_messages[left_index] if left_index is not None else None
        right = right_messages[right_index] if right_index is not None else None
        if message_signature(left) != message_signature(right):
            differences.append({
                'aligned_row': aligned_row,
                'trajectory_a_step': left_index + 1 if left_index is not None else None,
                'trajectory_b_step': right_index + 1 if right_index is not None else None,
                'category': message_category(left, right),
            })
    def first(category=None):
        return next((difference for difference in differences if category is None or difference['category'] == category), None)
    return {
        'mechanical_comparison': {
            'alignment': 'sequence alignment using role, tool calls, tool name, and bounded content similarity',
            'first_any_difference': first(),
            'first_external_input_difference': first('external_input'),
            'first_agent_decision_difference': first('agent_decision'),
            'first_environment_result_difference': first('environment_result'),
            'difference_count': len(differences),
            'note': 'Mechanical differences are evidence of divergence, not proof of causal impact on the final result.',
        },
        'trajectories': [trajectory_digest(record, budget=28000) for record in records],
    }


def chat_endpoint(base_url):
    base = base_url.rstrip('/')
    if base.endswith('/chat/completions'):
        return base
    return f'{base}/chat/completions' if base.endswith('/v1') else f'{base}/v1/chat/completions'


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
        if url.path == '/api/task-traces':
            required = ('benchmark', 'domain', 'task_id')
            values = {key: params.get(key, [''])[0] for key in required}
            if not all(values.values()):
                return self.send_json({'error': 'benchmark, domain, and task_id are required'}, 400)
            traces = [item for item in INDEX if all(item[key] == values[key] for key in required)]
            traces.sort(key=lambda item: (item['source_model'], item['pass'], item['id']))
            return self.send_json({'task': values, 'traces': [public(item) for item in traces]})
        files = {'/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/overrides.css': 'overrides.css'}
        if url.path not in files: return self.send_json({'error': 'Not found'}, 404)
        path = ROOT / 'static' / files[url.path]
        return self.respond(200, path.read_bytes(), (mimetypes.guess_type(path.name)[0] or 'application/octet-stream') + '; charset=utf-8')

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != '/api/analyze':
            return self.send_json({'error': 'Not found'}, 404)
        try:
            content_length = int(self.headers.get('Content-Length', '0'))
            if content_length <= 0 or content_length > 65536:
                raise ValueError('Invalid request size')
            request_data = json.loads(self.rfile.read(content_length))
            config = request_data.get('config') or {}
            base_url = str(config.get('base_url') or '').strip()
            api_key = str(config.get('api_key') or '').strip()
            model = str(config.get('model') or '').strip()
            if not base_url.startswith(('https://', 'http://')) or not api_key or not model:
                raise ValueError('Base URL, API key, and model are required')
            analysis_type = str(request_data.get('analysis_type') or 'trajectory')
            if analysis_type == 'comparison':
                record_ids = request_data.get('record_ids')
                if not isinstance(record_ids, list) or len(record_ids) != 2 or len(set(record_ids)) != 2:
                    raise ValueError('Exactly two distinct record_ids are required for comparison analysis')
                items = [BY_ID.get(str(record_id)) for record_id in record_ids]
                if any(item is None for item in items):
                    raise ValueError('Record not found')
                required = ('benchmark', 'domain', 'task_id')
                if any(items[0][key] != items[1][key] for key in required):
                    raise ValueError('Comparison records must belong to the same task')
                digest = comparison_digest([load_record(item) for item in items])
                prompt = (
                    'Compare these two agent trajectories for the same task. Do not invent facts beyond the saved traces and evaluator data. '
                    'Write in Chinese and cite trajectory A/B plus exact step numbers. Your response must have these sections: '
                    '(1) result contrast: evaluator facts for each trajectory; '
                    '(2) first divergence: use the supplied sequence alignment, distinguish external-input, agent-decision, and environment-result differences, and explain the concrete difference; '
                    '(3) outcome-critical divergence: identify the earliest difference that materially explains why one result succeeded and the other failed, or say the evidence is insufficient; '
                    '(4) relationship: explicitly state whether the first divergence is the outcome-critical divergence. If not, explain the intervening differences and causal chain; '
                    '(5) actionable improvement for the weaker trajectory. '
                    'Every factual or causal bullet must begin with exactly one evidence label: [评测器直接证据], [轨迹直接证据], [合理推断], or [无法从现有数据确定]. '
                    'Use [评测器直接证据] only for saved evaluator fields, [轨迹直接证据] only for observable messages/tool results, '
                    '[合理推断] for causality supported but not proven by the trace, and [无法从现有数据确定] when the dataset cannot establish the claim.\n\n'
                    + json.dumps(digest, ensure_ascii=False)
                )
            elif analysis_type == 'trajectory':
                item = BY_ID.get(str(request_data.get('record_id') or ''))
                if item is None:
                    raise ValueError('Record not found')
                digest = trajectory_digest(load_record(item))
                prompt = (
                    'Analyze why this agent trajectory succeeded or failed according to its saved evaluator data. '
                    'Do not invent facts beyond the trace. Write in Chinese. Structure the response with: '
                    '(1) verdict, (2) direct evaluator evidence, (3) causal trajectory analysis referencing step numbers and tool results, '
                    '(4) concrete improvements. Every factual or causal bullet must begin with exactly one evidence label: '
                    '[评测器直接证据], [轨迹直接证据], [合理推断], or [无法从现有数据确定]. '
                    'Use evaluator evidence only for saved evaluator fields, trace evidence only for observable messages/tool results, '
                    'reasonable inference for causality supported but not proven, and unknown when the saved data cannot establish the claim.\n\n'
                    + json.dumps(digest, ensure_ascii=False)
                )
            else:
                raise ValueError('Unknown analysis type')
            payload = json.dumps({
                'model': model,
                'temperature': 0.2,
                'max_tokens': 2600,
                'messages': [
                    {'role': 'system', 'content': 'You are a rigorous agent-trajectory evaluator.'},
                    {'role': 'user', 'content': prompt},
                ],
            }).encode()
            outbound = urllib.request.Request(
                chat_endpoint(base_url), data=payload,
                headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}, method='POST')
            with urllib.request.urlopen(outbound, timeout=120) as response:
                result = json.loads(response.read())
            content = result.get('choices', [{}])[0].get('message', {}).get('content')
            if isinstance(content, list):
                content = ''.join(part.get('text', '') if isinstance(part, dict) else str(part) for part in content)
            if not content:
                raise ValueError('The provider returned no assistant content')
            return self.send_json({'analysis': content, 'model': model})
        except urllib.error.HTTPError as error:
            body = error.read().decode(errors='replace')[:1000]
            return self.send_json({'error': f'Provider returned HTTP {error.code}: {body}'}, 502)
        except (urllib.error.URLError, TimeoutError) as error:
            return self.send_json({'error': f'Provider request failed: {error}'}, 502)
        except (ValueError, json.JSONDecodeError) as error:
            return self.send_json({'error': str(error)}, 400)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--dataset', type=Path, default=DATASET)
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    build_index(args.dataset)
    print(f'{len(INDEX)} trajectories indexed. Open http://127.0.0.1:{args.port}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
