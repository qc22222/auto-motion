"""准备 HyperFrames 字词对齐所需的固定版 whisper.cpp 与中文 small 模型。"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import sys
import time
import urllib.request
import zipfile
from pathlib import Path


WHISPER_RELEASE = "v1.8.6"
WHISPER_ZIP_URL = (
    "https://github.com/ggml-org/whisper.cpp/releases/download/"
    f"{WHISPER_RELEASE}/whisper-bin-x64.zip"
)
WHISPER_ZIP_SIZE = 4_093_849
WHISPER_ZIP_SHA256 = "b07ea0b1b4115a38e1a7b07debf581f0b77d999925f8acb8f39d322b0ba0a822"
WHISPER_FILES = {
    "Release/whisper-cli.exe": 489_472,
    "Release/whisper.dll": 484_864,
    "Release/ggml.dll": 67_072,
    "Release/ggml-base.dll": 636_416,
    "Release/ggml-cpu.dll": 782_848,
}
MODEL_REVISION = "c521a4b02f422512d734391fdf08bb08c0862f68"
MODEL_URL = (
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/"
    f"{MODEL_REVISION}/ggml-small.bin?download=true"
)
MODEL_SIZE = 487_601_967
MODEL_SHA256 = "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"


def read_url(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "video-harness-whisper-setup/1.0"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def download_resumable(url: str, target: Path, expected_size: int) -> None:
    if target.is_file() and target.stat().st_size == expected_size:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(f"{target.name}.part")
    offset = partial.stat().st_size if partial.exists() else 0
    headers = {"User-Agent": "video-harness-whisper-setup/1.0"}
    if offset:
        headers["Range"] = f"bytes={offset}-"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=120) as response:
        append = offset > 0 and response.status == 206
        if not append:
            offset = 0
        mode = "ab" if append else "wb"
        written = offset
        started = time.monotonic()
        with partial.open(mode) as output:
            while True:
                chunk = response.read(8 * 1024 * 1024)
                if not chunk:
                    break
                output.write(chunk)
                written += len(chunk)
                if written == expected_size or written % (64 * 1024 * 1024) < len(chunk):
                    speed = (written - offset) / max(0.001, time.monotonic() - started) / (1024 ** 2)
                    print(f"  {written / expected_size:6.1%} · {speed:5.1f} MiB/s", flush=True)
    if partial.stat().st_size != expected_size:
        raise RuntimeError(f"Whisper 模型大小不符：{partial}")
    os.replace(partial, target)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description="准备项目固定版本 Whisper 字词对齐环境")
    parser.add_argument("--runtime", required=True, help="whisper.cpp 运行目录")
    parser.add_argument("--model", required=True, help="HyperFrames small 模型目标路径")
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    runtime = Path(args.runtime).resolve()
    model_path = Path(args.model).resolve()
    runtime.mkdir(parents=True, exist_ok=True)

    for archive_name, expected_size in WHISPER_FILES.items():
        target = runtime / Path(archive_name).name
        if target.exists() and target.stat().st_size != expected_size:
            raise RuntimeError(f"现有 whisper.cpp 文件大小异常，请人工检查：{target}")
    if not args.verify_only and not all(
        (runtime / Path(name).name).is_file() for name in WHISPER_FILES
    ):
        print(f"[下载] whisper.cpp {WHISPER_RELEASE} Windows x64（{WHISPER_ZIP_SIZE / 1024 ** 2:.1f} MiB）")
        archive = read_url(WHISPER_ZIP_URL)
        if len(archive) != WHISPER_ZIP_SIZE or hashlib.sha256(archive).hexdigest() != WHISPER_ZIP_SHA256:
            raise RuntimeError("whisper.cpp 发布包校验失败")
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            for archive_name, expected_size in WHISPER_FILES.items():
                target = runtime / Path(archive_name).name
                if target.is_file():
                    continue
                data = bundle.read(archive_name)
                if len(data) != expected_size:
                    raise RuntimeError(f"whisper.cpp 文件大小不符：{archive_name}")
                target.write_bytes(data)

    if not model_path.is_file() or model_path.stat().st_size != MODEL_SIZE:
        if args.verify_only:
            raise RuntimeError(f"Whisper small 模型缺失：{model_path}")
        print(f"[下载] Whisper small 中文模型（{MODEL_SIZE / 1024 ** 2:.1f} MiB）")
        download_resumable(MODEL_URL, model_path, MODEL_SIZE)
    if sha256_file(model_path) != MODEL_SHA256:
        raise RuntimeError(f"Whisper small 模型 SHA256 校验失败：{model_path}")

    executable = runtime / "whisper-cli.exe"
    if not executable.is_file():
        raise RuntimeError(f"whisper-cli.exe 缺失：{executable}")
    manifest = {
        "schemaVersion": 1,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "runtime": {"version": WHISPER_RELEASE, "executable": str(executable)},
        "model": {"revision": MODEL_REVISION, "path": str(model_path), "sha256": MODEL_SHA256},
        "purpose": "IndexTTS2 分段旁白的中文词级对齐，不用于训练",
    }
    (runtime / "alignment-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"[完成] HYPERFRAMES_WHISPER_PATH={executable}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, zipfile.BadZipFile) as error:
        print(f"[失败] {error}", file=sys.stderr)
        raise SystemExit(1)
