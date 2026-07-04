#!/usr/bin/env python3
"""Génère le hash SHA-256 à coller dans docs/js/password.js (EXPECTED_HASH).

Usage: python3 scripts/hash_password.py "mon-code-d-acces"
"""
import hashlib
import sys

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python3 scripts/hash_password.py \"mon-code-d-acces\"")
        sys.exit(1)
    print(hashlib.sha256(sys.argv[1].encode("utf-8")).hexdigest())
