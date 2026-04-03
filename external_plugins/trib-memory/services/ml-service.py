#!/usr/bin/env python3
"""ML microservice — temporal parsing + reranker (MPS-accelerated)."""

import json
import os
import signal
import socket
import sys
import tempfile
from http.server import HTTPServer, BaseHTTPRequestHandler

import dateparser

# Kiwi tokenizer (lazy-loaded)
_kiwi = None


def get_kiwi():
    global _kiwi
    if _kiwi is None:
        from kiwipiepy import Kiwi
        _kiwi = Kiwi()
    return _kiwi


def tokenize_query(text):
    kiwi = get_kiwi()
    tokens = kiwi.tokenize(text)
    # NN(명사), VV(동사), VA(형용사), SL(외국어), SN(숫자)
    words = [tok.form for tok in tokens if tok.tag.startswith(('NN', 'VV', 'VA', 'SL', 'SN'))]
    return ' '.join(words)

# Lazy-loaded reranker
_reranker_model = None
_reranker_tokenizer = None
RERANKER_MODEL_ID = os.environ.get('TRIB_RERANKER_MODEL', 'BAAI/bge-reranker-v2-m3')


def get_reranker():
    global _reranker_model, _reranker_tokenizer
    if _reranker_model is None:
        try:
            import torch
            from transformers import AutoModelForSequenceClassification, AutoTokenizer
            device = 'mps' if torch.backends.mps.is_available() else 'cpu'
            sys.stderr.write(f"[reranker] loading {RERANKER_MODEL_ID} on {device}\n")
            _reranker_tokenizer = AutoTokenizer.from_pretrained(RERANKER_MODEL_ID)
            _reranker_model = AutoModelForSequenceClassification.from_pretrained(RERANKER_MODEL_ID)
            _reranker_model = _reranker_model.to(device).eval()
            sys.stderr.write(f"[reranker] ready on {device}\n")
        except Exception as e:
            sys.stderr.write(f"[reranker] load failed: {e}\n")
            return None, None
    return _reranker_model, _reranker_tokenizer


def rerank(query, documents, top_k=5):
    model, tokenizer = get_reranker()
    if model is None:
        return [{'index': i, 'score': 0} for i in range(min(top_k, len(documents)))]
    import torch
    device = next(model.parameters()).device
    pairs = [[query, doc] for doc in documents]
    inputs = tokenizer(pairs, padding=True, truncation=True, max_length=512, return_tensors='pt').to(device)
    with torch.no_grad():
        scores = model(**inputs).logits.squeeze(-1).float().cpu().tolist()
    if isinstance(scores, float):
        scores = [scores]
    indexed = [{'index': i, 'score': s} for i, s in enumerate(scores)]
    indexed.sort(key=lambda x: x['score'], reverse=True)
    return indexed[:top_k]

PORT_FILE = os.path.join(tempfile.gettempdir(), 'trib-memory', 'temporal-port')
BASE_PORT = 3360
MAX_PORT = 3367


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # All logs to stderr only
        sys.stderr.write(f"[temporal] {args[0]}\n")

    def do_POST(self):
        if self.path == '/temporal':
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            text = body.get('text', '')
            lang = body.get('lang', None)

            parsed = []
            if text:
                settings = {'PREFER_DATES_FROM': 'past', 'RETURN_AS_TIMEZONE_AWARE': False}

                # Try full text parse
                result = dateparser.parse(text, languages=[lang] if lang else None, settings=settings)
                if result:
                    parsed.append({'text': text, 'start': result.strftime('%Y-%m-%d'), 'end': None})
                else:
                    # Try search_dates (finds dates within text)
                    try:
                        from dateparser.search import search_dates
                        found = search_dates(text, languages=[lang] if lang else None, settings=settings)
                        if found:
                            parsed.append({'text': found[0][0], 'start': found[0][1].strftime('%Y-%m-%d'), 'end': None})
                    except Exception:
                        pass

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'parsed': parsed}).encode())
            return

        if self.path == '/tokenize':
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            text = body.get('text', '')
            result = tokenize_query(text) if text else ''
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'tokens': result}).encode())
            return

        if self.path == '/rerank':
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            query = body.get('query', '')
            documents = body.get('documents', [])
            top_k = body.get('top_k', 5)

            results = rerank(query, documents, top_k) if query and documents else []

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'results': results}).encode())
            return

        self.send_response(404)
        self.end_headers()

    def do_GET(self):
        if self.path == '/health':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'status': 'ok', 'service': 'temporal-parser'}).encode())
            return

        self.send_response(404)
        self.end_headers()


def write_port_file(port):
    os.makedirs(os.path.dirname(PORT_FILE), exist_ok=True)
    with open(PORT_FILE, 'w') as f:
        f.write(str(port))


def cleanup(*_):
    try:
        os.remove(PORT_FILE)
    except OSError:
        pass
    sys.exit(0)


def main():
    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)

    port = BASE_PORT
    while port <= MAX_PORT:
        try:
            server = HTTPServer(('127.0.0.1', port), Handler)
            break
        except OSError:
            port += 1
    else:
        sys.stderr.write(f"[temporal] all ports {BASE_PORT}-{MAX_PORT} in use\n")
        sys.exit(1)

    write_port_file(port)
    sys.stderr.write(f"[temporal] listening on port {port}\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        cleanup()


if __name__ == '__main__':
    main()
