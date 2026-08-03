"""按固定版本下载 IndexTTS2 推理所需的最小模型文件集。"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


FILES = (
    # IndexTTS2 主模型：保留推理权重、分词器和许可证，跳过 .gitattributes/Modelfile。
    ("IndexTeam/IndexTTS-2", "740dcaff396282ffb241903d150ac011cd4b1ede", "bpe.model", "bpe.model", 475_997),
    ("IndexTeam/IndexTTS-2", "740dcaff396282ffb241903d150ac011cd4b1ede", "config.yaml", "config.yaml", 2_882),
    ("IndexTeam/IndexTTS-2", "740dcaff396282ffb241903d150ac011cd4b1ede", "feat1.pt", "feat1.pt", 57_170),
    ("IndexTeam/IndexTTS-2", "740dcaff396282ffb241903d150ac011cd4b1ede", "feat2.pt", "feat2.pt", 374_866),
    ("IndexTeam/IndexTTS-2", "740dcaff396282ffb241903d150ac011cd4b1ede", "gpt.pth", "gpt.pth", 3_484_663_079),
    ("IndexTeam/IndexTTS-2", "740dcaff396282ffb241903d150ac011cd4b1ede", "s2mel.pth", "s2mel.pth", 1_202_198_223),
    ("IndexTeam/IndexTTS-2", "740dcaff396282ffb241903d150ac011cd4b1ede", "wav2vec2bert_stats.pt", "wav2vec2bert_stats.pt", 9_343),
    ("IndexTeam/IndexTTS-2", "740dcaff396282ffb241903d150ac011cd4b1ede", "LICENSE.txt", "LICENSE.txt", 10_554),
    ("IndexTeam/IndexTTS-2", "740dcaff396282ffb241903d150ac011cd4b1ede", "LICENSE_ZH.txt", "LICENSE_ZH.txt", 7_336),
    ("IndexTeam/IndexTTS-2", "740dcaff396282ffb241903d150ac011cd4b1ede", "README.md", "README.md", 2_511),
    ("IndexTeam/IndexTTS-2", "740dcaff396282ffb241903d150ac011cd4b1ede", "qwen0.6bemo4-merge/added_tokens.json", "qwen0.6bemo4-merge/added_tokens.json", 707),
    ("IndexTeam/IndexTTS-2", "740dcaff396282ffb241903d150ac011cd4b1ede", "qwen0.6bemo4-merge/chat_template.jinja", "qwen0.6bemo4-merge/chat_template.jinja", 550),
    ("IndexTeam/IndexTTS-2", "740dcaff396282ffb241903d150ac011cd4b1ede", "qwen0.6bemo4-merge/config.json", "qwen0.6bemo4-merge/config.json", 727),
    ("IndexTeam/IndexTTS-2", "740dcaff396282ffb241903d150ac011cd4b1ede", "qwen0.6bemo4-merge/generation_config.json", "qwen0.6bemo4-merge/generation_config.json", 117),
    ("IndexTeam/IndexTTS-2", "740dcaff396282ffb241903d150ac011cd4b1ede", "qwen0.6bemo4-merge/merges.txt", "qwen0.6bemo4-merge/merges.txt", 1_671_853),
    ("IndexTeam/IndexTTS-2", "740dcaff396282ffb241903d150ac011cd4b1ede", "qwen0.6bemo4-merge/model.safetensors", "qwen0.6bemo4-merge/model.safetensors", 1_192_135_096),
    ("IndexTeam/IndexTTS-2", "740dcaff396282ffb241903d150ac011cd4b1ede", "qwen0.6bemo4-merge/special_tokens_map.json", "qwen0.6bemo4-merge/special_tokens_map.json", 616),
    ("IndexTeam/IndexTTS-2", "740dcaff396282ffb241903d150ac011cd4b1ede", "qwen0.6bemo4-merge/tokenizer.json", "qwen0.6bemo4-merge/tokenizer.json", 11_422_654),
    ("IndexTeam/IndexTTS-2", "740dcaff396282ffb241903d150ac011cd4b1ede", "qwen0.6bemo4-merge/tokenizer_config.json", "qwen0.6bemo4-merge/tokenizer_config.json", 5_433),
    ("IndexTeam/IndexTTS-2", "740dcaff396282ffb241903d150ac011cd4b1ede", "qwen0.6bemo4-merge/vocab.json", "qwen0.6bemo4-merge/vocab.json", 2_776_833),
    # 辅助模型：W2V-BERT 只取 safetensors，明确跳过约 2.17 GiB 的重复 conformer_shaw.pt。
    ("facebook/w2v-bert-2.0", "da985ba0987f70aaeb84a80f2851cfac8c697a7b", "config.json", "hf_cache/w2v-bert-2.0/config.json", 1_874),
    ("facebook/w2v-bert-2.0", "da985ba0987f70aaeb84a80f2851cfac8c697a7b", "preprocessor_config.json", "hf_cache/w2v-bert-2.0/preprocessor_config.json", 275),
    ("facebook/w2v-bert-2.0", "da985ba0987f70aaeb84a80f2851cfac8c697a7b", "model.safetensors", "hf_cache/w2v-bert-2.0/model.safetensors", 2_322_063_736),
    ("amphion/MaskGCT", "265c6cef07625665d0c28d2faafb1415562379dc", "semantic_codec/model.safetensors", "hf_cache/semantic_codec_model.safetensors", 177_183_712),
    ("funasr/campplus", "e4b6ede7ce16997aff4ae69fbca1f0175e2afede", "campplus_cn_common.bin", "hf_cache/campplus_cn_common.bin", 28_036_335),
    ("nvidia/bigvgan_v2_22khz_80band_256x", "633ff708ed5b74903e86ff1298cf4a98e921c513", "config.json", "hf_cache/bigvgan/config.json", 1_405),
    ("nvidia/bigvgan_v2_22khz_80band_256x", "633ff708ed5b74903e86ff1298cf4a98e921c513", "bigvgan_generator.pt", "hf_cache/bigvgan/bigvgan_generator.pt", 449_228_171),
)

# 优先使用 IndexTTS2 官方下载脚本采用的 ModelScope 仓库映射；
# 每个地址仍固定到明确提交，文件尺寸继续按上方清单做最终校验。
MODELSCOPE_SOURCES = {
    "IndexTeam/IndexTTS-2": (
        "IndexTeam/IndexTTS-2",
        "f165d7e5bd70d292969875d89d6e5d4fc8b328ca",
    ),
    "facebook/w2v-bert-2.0": (
        "AI-ModelScope/w2v-bert-2.0",
        "fc76caf6922661691d672f6494d821585975bc98",
    ),
    "amphion/MaskGCT": (
        "amphion/MaskGCT",
        "f413985be524579156abf5fe3a6a0b4fcc03b117",
    ),
    "funasr/campplus": (
        "iic/speech_campplus_sv_zh-cn_16k-common",
        "a045b2afcaa9c3049c98a9215a2bc274407ab237",
    ),
    "nvidia/bigvgan_v2_22khz_80band_256x": (
        "nv-community/bigvgan_v2_22khz_80band_256x",
        "28f63362719fc3b44bf7b9ca7b302c7fd0e34752",
    ),
}

SHA256 = {
    (
        "nvidia/bigvgan_v2_22khz_80band_256x",
        "bigvgan_generator.pt",
    ): "e95ba25972d3de0628d99cd156e9315a9c018899bf739988959ebe3544080ced",
}


def human_size(value: int) -> str:
    return f"{value / (1024 ** 3):.2f} GiB" if value >= 1024 ** 3 else f"{value / (1024 ** 2):.1f} MiB"


def verify_sha256(path: Path, expected: str | None) -> None:
    if not expected:
        return
    digest = hashlib.sha256()
    with path.open("rb") as source_file:
        for chunk in iter(lambda: source_file.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    actual = digest.hexdigest()
    if actual != expected:
        raise RuntimeError(f"SHA-256 校验失败：{path}，预期 {expected}，实际 {actual}")


def resolve_download(repo: str, revision: str, source: str) -> tuple[str, str, str]:
    encoded_source = urllib.parse.quote(source, safe="/")
    if repo in MODELSCOPE_SOURCES:
        mirror_repo, mirror_revision = MODELSCOPE_SOURCES[repo]
        return (
            f"https://modelscope.cn/models/{mirror_repo}/resolve/{mirror_revision}/{encoded_source}",
            "ModelScope",
            mirror_revision,
        )
    return (
        f"https://huggingface.co/{repo}/resolve/{revision}/{encoded_source}?download=true",
        "Hugging Face",
        revision,
    )


def download_file(repo: str, revision: str, source: str, target: Path, expected_size: int) -> None:
    expected_sha256 = SHA256.get((repo, source))
    if target.is_file() and target.stat().st_size == expected_size:
        verify_sha256(target, expected_sha256)
        print(f"[跳过] {target.name} 已完整存在（{human_size(expected_size)}）", flush=True)
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(f"{target.name}.part")
    offset = partial.stat().st_size if partial.exists() else 0
    if offset > expected_size:
        raise RuntimeError(f"临时文件大于预期，需人工检查：{partial}")
    url, provider, download_revision = resolve_download(repo, revision, source)
    headers = {"User-Agent": "video-harness-indextts2-minimal/1.0"}
    if offset:
        headers["Range"] = f"bytes={offset}-"
    request = urllib.request.Request(url, headers=headers)
    print(
        f"[下载] {repo}/{source} -> {target}"
        f"（{human_size(expected_size)}，续传 {human_size(offset)}，{provider}@{download_revision[:8]}）",
        flush=True,
    )
    try:
        response = urllib.request.urlopen(request, timeout=120)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"下载失败 HTTP {error.code}：{repo}/{source}") from error
    append = offset > 0 and response.status == 206
    if offset > 0 and not append:
        offset = 0
    mode = "ab" if append else "wb"
    started = time.monotonic()
    written = offset
    with response, partial.open(mode) as output:
        while True:
            chunk = response.read(8 * 1024 * 1024)
            if not chunk:
                break
            output.write(chunk)
            written += len(chunk)
            elapsed = max(0.001, time.monotonic() - started)
            if written == expected_size or written % (256 * 1024 * 1024) < len(chunk):
                speed = (written - offset) / elapsed / (1024 ** 2)
                print(f"         {written / expected_size:6.1%} · {speed:5.1f} MiB/s", flush=True)
    actual_size = partial.stat().st_size
    if actual_size != expected_size:
        raise RuntimeError(f"文件大小校验失败：{partial}，预期 {expected_size}，实际 {actual_size}")
    verify_sha256(partial, expected_sha256)
    os.replace(partial, target)


def main() -> int:
    parser = argparse.ArgumentParser(description="下载 IndexTTS2 固定版本最小模型集")
    parser.add_argument("--target", required=True, help="模型输出目录")
    parser.add_argument("--verify-only", action="store_true", help="只校验，不联网下载")
    args = parser.parse_args()
    target_root = Path(args.target).resolve()
    target_root.mkdir(parents=True, exist_ok=True)
    total_size = sum(item[4] for item in FILES)
    print(f"IndexTTS2 最小模型集：{len(FILES)} 个文件，共 {human_size(total_size)}", flush=True)
    for repo, revision, source, destination, expected_size in FILES:
        target = target_root / destination
        if args.verify_only:
            if not target.is_file() or target.stat().st_size != expected_size:
                raise RuntimeError(f"模型文件缺失或大小不符：{target}")
        else:
            download_file(repo, revision, source, target, expected_size)
    manifest = {
        "schemaVersion": 1,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "policy": {"inferenceDevice": "cuda:0", "fp16": True, "cpuFallback": False, "training": False},
        "fileCount": len(FILES),
        "totalBytes": total_size,
        "skippedRedundant": ["facebook/w2v-bert-2.0/conformer_shaw.pt"],
        "files": [
            {
                "repo": repo,
                "revision": revision,
                "source": source,
                "path": destination,
                "bytes": size,
                "downloadProvider": resolve_download(repo, revision, source)[1],
                "downloadRevision": resolve_download(repo, revision, source)[2],
                "sha256": SHA256.get((repo, source)),
            }
            for repo, revision, source, destination, size in FILES
        ],
    }
    (target_root / "model-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"[完成] 模型清单：{target_root / 'model-manifest.json'}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError) as error:
        print(f"[失败] {error}", file=sys.stderr, flush=True)
        raise SystemExit(1)
