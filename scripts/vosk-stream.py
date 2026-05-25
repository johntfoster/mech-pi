#!/usr/bin/env python3
"""Streaming Vosk stdin->JSON-lines transcriber for mech-pi.

Reads 16 kHz mono signed 16-bit little-endian PCM from stdin and writes JSON
lines to stdout:
  {"type":"ready"}
  {"type":"partial","text":"..."}
  {"type":"final","text":"..."}
  {"type":"closed"}
"""
from __future__ import annotations

import argparse
import json
import sys


def emit(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Streaming Vosk stdin transcriber")
    parser.add_argument("--model", default=None, help="Vosk model directory")
    parser.add_argument("--model-name", default=None, help="Vosk model name to find/download")
    parser.add_argument("--lang", default="en", help="Language for Vosk model auto-selection")
    parser.add_argument("--sample-rate", type=float, default=16000.0)
    parser.add_argument("--chunk-size", type=int, default=4000)
    parser.add_argument("--words", action="store_true")
    args = parser.parse_args()

    try:
        from vosk import KaldiRecognizer, Model, SetLogLevel
    except Exception as exc:  # pragma: no cover - startup diagnostic
        emit({"type": "error", "message": f"Python vosk package is not importable: {exc}"})
        return 2

    try:
        SetLogLevel(-1)
        model = Model(model_path=args.model) if args.model else Model(model_name=args.model_name, lang=args.lang)
        rec = KaldiRecognizer(model, args.sample_rate)
        rec.SetWords(bool(args.words))
    except SystemExit as exc:
        emit({"type": "error", "message": f"Vosk model setup exited with {exc.code}"})
        return int(exc.code or 1)
    except Exception as exc:
        emit({"type": "error", "message": f"Vosk model setup failed: {exc}"})
        return 2

    emit({"type": "ready"})
    last_partial = ""
    try:
        while True:
            data = sys.stdin.buffer.read(max(1, args.chunk_size))
            if not data:
                break
            if rec.AcceptWaveform(data):
                result = json.loads(rec.Result() or "{}")
                text = (result.get("text") or "").strip()
                last_partial = ""
                if text:
                    emit({"type": "final", "text": text})
                else:
                    emit({"type": "partial", "text": ""})
            else:
                result = json.loads(rec.PartialResult() or "{}")
                partial = (result.get("partial") or "").strip()
                if partial != last_partial:
                    last_partial = partial
                    emit({"type": "partial", "text": partial})
        result = json.loads(rec.FinalResult() or "{}")
        text = (result.get("text") or "").strip()
        if text:
            emit({"type": "final", "text": text})
        emit({"type": "closed"})
        return 0
    except BrokenPipeError:
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception as exc:
        emit({"type": "error", "message": f"Vosk streaming failed: {exc}"})
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
