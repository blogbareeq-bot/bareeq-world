#!/usr/bin/env python3
"""Optional CAMeL Tools advisory layer for Bareeq Arabic Quality Gate.

This script never rewrites source content. It tokenizes Arabic with CAMeL Tools,
checks Unicode/diacritic anomalies and emits an advisory JSON report.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path


def load_camel():
    try:
        from camel_tools.tokenizers.word import simple_word_tokenize
        from camel_tools.utils.dediac import dediac_ar
        from camel_tools.utils.normalize import normalize_unicode
        import camel_tools
        return simple_word_tokenize, dediac_ar, normalize_unicode, getattr(camel_tools, "__version__", "unknown")
    except Exception as exc:  # pragma: no cover - environment dependent
        return None, None, None, f"unavailable: {exc}"


def strip_frontmatter(text: str) -> str:
    if not text.startswith("---"):
        return text
    lines = text.splitlines()
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return "\n".join(lines[i + 1 :])
    return text


def strip_markdown(text: str) -> str:
    text = re.sub(r"```[\s\S]*?```", " ", text)
    text = re.sub(r"`[^`]*`", " ", text)
    text = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"https?://\S+", " ", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"^[#>\-*+\d.)\s]+", "", text, flags=re.MULTILINE)
    return text


def line_for_offset(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def finding(rule_id: str, file: str, message: str, line: int | None = None, excerpt: str | None = None):
    return {
        "ruleId": rule_id,
        "severity": "warning",
        "provider": "camel-tools",
        "file": file,
        "line": line,
        "message": message,
        "excerpt": excerpt,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".")
    parser.add_argument("--content-root", action="append", default=["src/content/posts"])
    parser.add_argument("--output", default=".bareeq/qa/bareeq-camel-qa.json")
    parser.add_argument("--require", action="store_true", help="Fail if CAMeL Tools is unavailable")
    args = parser.parse_args()

    simple_word_tokenize, dediac_ar, normalize_unicode, version = load_camel()
    root = Path(args.root).resolve()
    output = root / args.output
    output.parent.mkdir(parents=True, exist_ok=True)

    if simple_word_tokenize is None:
        report = {
            "schemaVersion": 1,
            "provider": "camel-tools",
            "status": "skipped",
            "version": version,
            "findings": [],
        }
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"CAMeL advisory skipped: {version}")
        return 2 if args.require else 0

    files: list[Path] = []
    for content_root in args.content_root:
        base = root / content_root
        if base.exists():
            files.extend(sorted(base.rglob("*.md")))
            files.extend(sorted(base.rglob("*.mdx")))

    findings = []
    stats = {"files": 0, "tokens": 0, "arabicTokens": 0}
    mixed_re = re.compile(r"(?=.*[\u0600-\u06FF])(?=.*[A-Za-z])\S+")
    orphan_diac_re = re.compile(r"(?<![\u0621-\u064A])[\u064B-\u065F\u0670]")
    repeated_diac_re = re.compile(r"([\u064B-\u065F\u0670])\1+")

    for file_path in files:
        rel = file_path.relative_to(root).as_posix()
        source = file_path.read_text(encoding="utf-8")
        body = strip_markdown(strip_frontmatter(source))
        stats["files"] += 1

        normalized = normalize_unicode(body)
        if normalized != body:
            findings.append(finding(
                "CAMEL-UNICODE-001",
                rel,
                "CAMeL Unicode normalization changes this text; inspect compatibility characters before publication.",
                1,
            ))

        tokens = simple_word_tokenize(body)
        stats["tokens"] += len(tokens)
        stats["arabicTokens"] += sum(1 for token in tokens if re.search(r"[\u0600-\u06FF]", token))

        for token in tokens:
            if mixed_re.fullmatch(token):
                pos = source.find(token)
                findings.append(finding(
                    "CAMEL-TOKEN-001",
                    rel,
                    "CAMeL tokenization found a token mixing Arabic and Latin scripts.",
                    line_for_offset(source, max(pos, 0)),
                    token,
                ))

        for match in orphan_diac_re.finditer(body):
            findings.append(finding(
                "CAMEL-DIAC-001",
                rel,
                "Arabic diacritic appears without a preceding Arabic base letter.",
                line_for_offset(body, match.start()),
                unicodedata.name(match.group(0), "ARABIC DIACRITIC"),
            ))
            break

        for match in repeated_diac_re.finditer(body):
            findings.append(finding(
                "CAMEL-DIAC-002",
                rel,
                "Repeated identical Arabic diacritic detected.",
                line_for_offset(body, match.start()),
                match.group(0),
            ))
            break

        for token in tokens:
            if re.search(r"[\u0600-\u06FF]", token):
                dediac_ar(token)

    report = {
        "schemaVersion": 1,
        "provider": "camel-tools",
        "status": "ran",
        "version": version,
        "summary": {**stats, "findings": len(findings)},
        "findings": findings,
    }
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"CAMeL advisory: {stats['files']} files, {stats['tokens']} tokens, {len(findings)} warning(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
