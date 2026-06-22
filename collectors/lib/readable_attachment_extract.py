#!/usr/bin/env python3
"""Extract readable text from safe email attachment types.

Used by GBRAIN email ingestion. The extractor is deliberately allowlist-based:
PDF, Office documents, text/CSV/JSON/HTML/Markdown. Unknown binaries return
empty text with a skip reason.
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


MAX_TEXT_CHARS = int(os.environ.get("GBRAIN_ATTACHMENT_MAX_TEXT_CHARS", "60000"))
OCR_MIN_CHARS = int(os.environ.get("GBRAIN_ATTACHMENT_OCR_MIN_CHARS", "200"))
OCR_MAX_PAGES = int(os.environ.get("GBRAIN_ATTACHMENT_OCR_MAX_PAGES", "8"))


def clean_text(text: str) -> str:
    text = html.unescape(text or "")
    text = text.replace("\x00", " ")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{4,}", "\n\n\n", text)
    text = re.sub(r"[ \t]{3,}", "  ", text)
    return text.strip()[:MAX_TEXT_CHARS]


def ext_for(path: Path) -> str:
    return path.suffix.lower().lstrip(".")


def run_text(cmd: list[str], timeout: int = 120) -> str:
    try:
        out = subprocess.run(cmd, check=False, capture_output=True, text=True, timeout=timeout)
    except Exception:
        return ""
    if out.returncode != 0:
        return ""
    return out.stdout or ""


def extract_plain(path: Path) -> tuple[str, str]:
    try:
        data = path.read_bytes()
    except Exception:
        return "", "read-failed"
    for enc in ("utf-8", "utf-16", "latin-1"):
        try:
            return clean_text(data.decode(enc)), f"text-{enc}"
        except Exception:
            continue
    return "", "decode-failed"


def strip_html(text: str) -> str:
    text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.I)
    text = re.sub(r"<script[\s\S]*?</script>", " ", text, flags=re.I)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</p>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return clean_text(text)


def extract_docx(path: Path) -> tuple[str, str]:
    try:
        with zipfile.ZipFile(path, "r") as zf:
            xml = zf.read("word/document.xml")
    except Exception:
        return "", "docx-read-failed"
    try:
        root = ET.fromstring(xml)
    except Exception:
        return "", "docx-xml-failed"
    ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    lines: list[str] = []
    for para in root.iter(f"{ns}p"):
        bits = [node.text or "" for node in para.iter(f"{ns}t")]
        line = "".join(bits).strip()
        if line:
            lines.append(line)
    return clean_text("\n".join(lines)), "docx-xml"


def extract_pptx(path: Path) -> tuple[str, str]:
    try:
        with zipfile.ZipFile(path, "r") as zf:
            names = sorted(n for n in zf.namelist() if n.startswith("ppt/slides/slide") and n.endswith(".xml"))
            chunks: list[str] = []
            for name in names:
                root = ET.fromstring(zf.read(name))
                chunks.extend(node.text or "" for node in root.iter() if node.tag.endswith("}t"))
    except Exception:
        return "", "pptx-read-failed"
    return clean_text("\n".join(x.strip() for x in chunks if x.strip())), "pptx-xml"


def extract_xlsx(path: Path) -> tuple[str, str]:
    try:
        import openpyxl  # type: ignore
    except Exception:
        return "", "xlsx-openpyxl-missing"
    try:
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        rows: list[str] = []
        for ws in wb.worksheets[:20]:
            rows.append(f"## Sheet: {ws.title}")
            for row in ws.iter_rows(max_row=500, values_only=True):
                values = [str(v).strip() for v in row if v is not None and str(v).strip()]
                if values:
                    rows.append("\t".join(values))
    except Exception:
        return "", "xlsx-read-failed"
    return clean_text("\n".join(rows)), "xlsx-openpyxl"


def extract_pdf_text(path: Path) -> tuple[str, str]:
    if shutil.which("pdftotext"):
        text = run_text(["pdftotext", "-layout", "-enc", "UTF-8", str(path), "-"], timeout=180)
        if len(text.strip()) >= OCR_MIN_CHARS:
            return clean_text(text), "pdf-pdftotext"

    try:
        from pdfminer.high_level import extract_text as pdfminer_extract  # type: ignore
        text = pdfminer_extract(str(path)) or ""
        if len(text.strip()) >= OCR_MIN_CHARS:
            return clean_text(text), "pdf-pdfminer"
    except Exception:
        text = ""

    ocr = ocr_pdf(path)
    if ocr.strip():
        return clean_text(ocr), "pdf-ocr-tesseract"
    return clean_text(text), "pdf-no-readable-text"


def pdf_page_count(path: Path) -> int:
    if not shutil.which("pdfinfo"):
        return OCR_MAX_PAGES
    out = run_text(["pdfinfo", str(path)], timeout=30)
    m = re.search(r"^Pages:\s+(\d+)", out, re.M)
    return int(m.group(1)) if m else OCR_MAX_PAGES


def ocr_pdf(path: Path) -> str:
    if not shutil.which("pdftoppm") or not shutil.which("tesseract"):
        return ""
    page_count = min(pdf_page_count(path), OCR_MAX_PAGES)
    with tempfile.TemporaryDirectory(prefix="gbrain-ocr-") as td:
        prefix = str(Path(td) / "page")
        try:
            subprocess.run(["pdftoppm", "-r", "180", "-f", "1", "-l", str(page_count), "-png", str(path), prefix], check=False, capture_output=True, timeout=180)
        except Exception:
            return ""
        texts: list[str] = []
        for img in sorted(Path(td).glob("page-*.png")):
            texts.append(run_text(["tesseract", str(img), "stdout", "--psm", "6"], timeout=120))
        return "\n\n".join(texts)


def extract(path: Path) -> dict:
    extension = ext_for(path)
    if extension == "pdf":
        text, method = extract_pdf_text(path)
    elif extension == "docx":
        text, method = extract_docx(path)
    elif extension in {"xlsx", "xlsm"}:
        text, method = extract_xlsx(path)
    elif extension == "pptx":
        text, method = extract_pptx(path)
    elif extension in {"txt", "md", "csv", "json", "xml", "log"}:
        text, method = extract_plain(path)
    elif extension in {"html", "htm"}:
        raw, method = extract_plain(path)
        text = strip_html(raw)
        method = f"{method}+html-strip"
    else:
        return {"ok": False, "text": "", "method": "skipped-extension", "reason": f"unsupported extension: {extension or 'none'}"}
    return {"ok": bool(text.strip()), "text": text, "method": method, "reason": "" if text.strip() else "no readable text extracted"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path")
    args = parser.parse_args()
    result = extract(Path(args.path))
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
