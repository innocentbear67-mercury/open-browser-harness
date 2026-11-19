#!/usr/bin/env python3
"""Native Messaging host for Open Browser Harness.

Chrome talks to this process over stdin/stdout with 4-byte little-endian
length-prefixed JSON. Keys live in the macOS Keychain, not in Chrome or in
this repo. Provider HTTP requests are made here, so long-lived keys never
enter the extension and browser CORS does not apply.

Actions: ping, store_key, delete_key, list_keys, http
(No get_key: the key is only ever injected into outgoing https requests.)
"""
import json
import os
import struct
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

SERVICE = "com.kundi.harness.key"
PLACEHOLDER = "__HARNESS_KEYCHAIN_KEY__"
INDEX = Path.home() / "Library" / "Application Support" / "OpenBrowserHarness" / "keys.json"


def read_message():
    raw = sys.stdin.buffer.read(4)
    if not raw:
        return None
    if len(raw) < 4:
        raise ValueError("short length prefix")
    length = struct.unpack("<I", raw)[0]
    if length > 10 * 1024 * 1024:
        raise ValueError("message too large")
    data = sys.stdin.buffer.read(length)
    return json.loads(data.decode("utf-8"))


def write_message(obj):
    data = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def security(*args):
    proc = subprocess.run(["security", *args], capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "security failed").strip()[:300])
    return proc.stdout.strip()


def index_read():
    try:
        return json.loads(INDEX.read_text())
    except (OSError, ValueError):
        return []


def index_write(providers):
    INDEX.parent.mkdir(parents=True, exist_ok=True)
    INDEX.write_text(json.dumps(sorted(set(providers))))


def handle(msg):
    action = msg.get("action") or msg.get("type")

    if action == "ping":
        return {"ok": True, "version": "0.1.0"}
    if action == "list_keys":
        return {"ok": True, "providers": index_read()}

    provider = str(msg.get("provider", ""))
    if not provider or any(c in provider for c in "\n\r\x00/\\"):
        raise ValueError("invalid provider id")

    if action == "store_key":
        key = str(msg.get("key", ""))
        if not key:
            raise ValueError("empty key")
        security("add-generic-password", "-a", provider, "-s", SERVICE, "-w", key, "-U")
        index_write(index_read() + [provider])
        return {"ok": True, "stored": provider}

    if action == "delete_key":
        try:
            security("delete-generic-password", "-a", provider, "-s", SERVICE)
        except RuntimeError as e:
            return {"ok": False, "error": str(e)}
        index_write([p for p in index_read() if p != provider])
        return {"ok": True, "deleted": provider}

    if action == "http":
        url = str(msg.get("url", ""))
        if not url.startswith(("https://", "http://")):
            raise ValueError("unsupported url")
        method = str(msg.get("method", "GET")).upper()
        headers = {str(k): str(v) for k, v in (msg.get("headers") or {}).items()}
        if any(PLACEHOLDER in v for v in headers.values()):
            # Only ever send a real key over TLS.
            if not url.startswith("https://"):
                raise ValueError("refusing to send key over plain http")
            try:
                key = security("find-generic-password", "-a", provider, "-s", SERVICE, "-w")
            except RuntimeError:
                return {"ok": False, "error": "key_not_found"}
            headers = {k: v.replace(PLACEHOLDER, key) for k, v in headers.items()}
        body = msg.get("body")
        payload = body.encode("utf-8") if isinstance(body, str) and body else None
        req = urllib.request.Request(url, data=payload, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                return {"ok": True, "status": resp.status, "text": resp.read().decode("utf-8", "replace")}
        except urllib.error.HTTPError as e:
            return {"ok": True, "status": e.code, "text": e.read().decode("utf-8", "replace")}
        except urllib.error.URLError as e:
            return {"ok": False, "error": f"network:{e.reason}"}

    raise ValueError(f"unknown_action:{action}")


def main():
    while True:
        try:
            msg = read_message()
        except (ValueError, json.JSONDecodeError) as e:
            write_message({"ok": False, "error": f"bad_message:{e}"})
            return
        if msg is None:
            return
        try:
            result = handle(msg)
            if "id" in msg:
                result["id"] = msg["id"]
            write_message(result)
        except Exception as e:  # never leak keys into an error string
            result = {"ok": False, "error": f"{type(e).__name__}:{str(e)[:300]}"}
            if "id" in msg:
                result["id"] = msg["id"]
            write_message(result)


if __name__ == "__main__":
    main()
