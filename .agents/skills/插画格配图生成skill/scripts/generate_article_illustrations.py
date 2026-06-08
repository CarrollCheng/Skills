#!/usr/bin/env python3
"""Generate three article illustrations through APIMart image tasks."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_BASE_URL = "https://api.apimart.ai/v1"
DEFAULT_MODEL = "gemini-3-pro-image-preview"
WINDOWS = [
    ("front", "01-front", "前30%", 0.0, 0.30),
    ("middle", "02-middle", "中间30%", 0.35, 0.65),
    ("ending", "03-ending", "最后30%", 0.70, 1.0),
]
STYLE_RULES = (
    "手绘漫画风格，温暖、亲和、有故事感，适合中文内容平台配图；"
    "画面干净，主体清晰，不偏写实，不偏赛博朋克。"
)
TEXT_RULES = "画面中不要出现任何文字、字母、单词、标签、标题或伪文字；如果确实无法避免，只能使用简体中文，且不超过8个汉字。"
NEGATIVE_RULES = "不要英文、乱码、伪文字、水印、logo、复杂海报排版、写实摄影、3D渲染、赛博朋克、阴冷恐怖氛围。"
SECTION_DIRECTIONS = {
    "前30%": "开篇配图要交代人物、场景和核心问题，让读者一眼知道文章在关心什么。",
    "中间30%": "中段配图要表现机制、行动或变化，让抽象方法变成可见的故事瞬间。",
    "最后30%": "尾段配图要表现结果、解决方案或余韵，让画面有收束感和希望感。",
}


class ApimartError(RuntimeError):
    pass


def read_article(path: str) -> str:
    if path == "-":
        text = sys.stdin.read()
    else:
        text = Path(path).read_text(encoding="utf-8")
    text = text.strip()
    if not text:
        raise SystemExit("Article is empty.")
    return text


def clean_markdown(text: str) -> str:
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = re.sub(r"!\[[^\]]*\]\([^)]+\)", " ", text)
    text = re.sub(r"\[[^\]]+\]\([^)]+\)", lambda m: re.sub(r"[\[\]\(\)]", "", m.group(0)).split("http", 1)[0], text)
    text = re.sub(r"<[^>]+>", " ", text)
    return text


def extract_title(text: str) -> str:
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        heading = re.match(r"^#{1,6}\s+(.+)$", stripped)
        if heading:
            return heading.group(1).strip()[:80]
        return re.sub(r"^[#>*\-\s]+", "", stripped)[:80]
    return "未命名文章"


def split_paragraphs(text: str) -> list[str]:
    cleaned = clean_markdown(text)
    chunks = re.split(r"\n\s*\n+", cleaned)
    paragraphs: list[str] = []
    for chunk in chunks:
        normalized = normalize_content_chunk(chunk)
        if len(normalized) >= 8:
            paragraphs.append(normalized)
    if not paragraphs:
        normalized = re.sub(r"\s+", " ", cleaned).strip()
        if normalized:
            paragraphs.append(normalized)
    return paragraphs


def fallback_slice(text: str, start: float, end: float) -> str:
    compact = normalize_content_chunk(clean_markdown(text))
    if not compact:
        return ""
    a = int(len(compact) * start)
    b = max(a + 1, int(len(compact) * end))
    return compact[a:b]


def section_texts(text: str) -> dict[str, str]:
    paragraphs = split_paragraphs(text)
    total = sum(len(p) for p in paragraphs)
    if total == 0:
        raise SystemExit("Article has no readable text.")

    positioned: list[tuple[str, float, float, float]] = []
    cursor = 0
    for paragraph in paragraphs:
        start = cursor / total
        cursor += len(paragraph)
        end = cursor / total
        center = (start + end) / 2
        positioned.append((paragraph, start, end, center))

    result: dict[str, str] = {}
    for key, _filename, _label, start, end in WINDOWS:
        selected = [p for p, _s, _e, center in positioned if start <= center <= end]
        if not selected:
            selected = [p for p, s, e, _center in positioned if max(s, start) < min(e, end)]
        joined = "\n".join(selected).strip() if selected else fallback_slice(text, start, end)
        result[key] = trim_excerpt(joined)
    return result


def normalize_content_chunk(chunk: str) -> str:
    lines: list[str] = []
    for raw_line in chunk.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if re.match(r"^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$", line):
            continue
        if line.count("|") >= 3:
            continue
        line = re.sub(r"^#{1,6}\s*", "", line)
        line = re.sub(r"^[>*\-\s]+", "", line)
        line = re.sub(r"`[^`]+`", " ", line)
        line = re.sub(r"[A-Za-z][A-Za-z0-9_./:-]{2,}", " ", line)
        line = re.sub(r"[\U0001F300-\U0001FAFF]", " ", line)
        line = re.sub(r"\s+", " ", line).strip()
        if line:
            lines.append(line)
    return re.sub(r"\s+", " ", " ".join(lines)).strip()


def trim_excerpt(text: str, limit: int = 650) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def keyword_scene_hint(title: str, label: str, excerpt: str) -> str | None:
    text = f"{title} {excerpt}"
    if any(word in text for word in ("早读", "朗读", "课堂", "教师", "学生")):
        if label == "前30%":
            return "清晨的教室里，一位语文老师站在讲台旁观察学生朗读，有的孩子开口很小，有的走神，窗外晨光柔和，画面表达早读管理的真实难题。"
        if label == "最后30%":
            return "早读结束后的教室里，学生仍然带着投入的表情读书，老师轻松地回看温暖的成长反馈，大屏上保留着活泼的小动物画面，整体有收束感和希望感。"
        if any(word in text for word in ("动物", "音量", "分贝", "达标", "麦克风", "繁衍", "连击")):
            return "教室大屏把孩子们的朗读声转化成不断出现的小动物，学生越读越投入，老师在一旁微笑调节目标，画面表现声音被即时可视化激励。"
        return "清晨教室里，老师和学生围绕一次更投入的朗读形成积极互动，画面表达早读氛围被温柔地带动起来。"
    if any(word in text for word in ("求职", "简历", "面试", "作品集", "职业", "岗位", "候选人", "招聘")):
        if label == "前30%":
            return "一位准备转向AI产品经理的求职者站在明亮书桌前，桌上有简历、作品集草稿和AI产品卡片，远处是打开机会之门的职场场景，画面表达行业从模型竞争走向产品落地。"
        if label == "中间30%":
            return "求职者把三块无字能力拼图组合成一条成长路线，周围只有图标、色块、线条、空白草图和数据图形，没有任何可读文字，画面表现能力建设正在成形。"
        return "求职者自信地带着作品集走进面试会议室，面试官微笑倾听，窗外有通向未来职业路径的温暖光线，画面表达准备充分后的成长机会。"
    if any(word in text for word in ("产品", "工具", "界面", "用户", "流程", "方案", "功能")):
        if label == "前30%":
            return "一个用户在日常工作场景中遇到具体痛点，旁边有简洁的工具雏形作为希望的线索，画面表达问题被看见。"
        if label == "中间30%":
            return "几个人围绕一个清晰的工具原型协作，把复杂流程变成简单可执行的步骤，画面表达方案正在运转。"
        return "工具稳定落地后，用户轻松完成任务，环境变得有秩序、有温度，画面表达结果和价值。"
    return None


def visual_brief(title: str, label: str, excerpt: str) -> str:
    keyword_hint = keyword_scene_hint(title, label, excerpt)
    if keyword_hint:
        return keyword_hint

    candidates = re.split(r"[。！？；;]|\s+\d+(?:\.\d+)+\s+|\s+[一二三四五六七八九十]+、", excerpt)
    candidates = [re.sub(r"[*#|]+", " ", c).strip(" ：:，,") for c in candidates]
    candidates = [re.sub(r"\s+", " ", c).strip() for c in candidates if len(c.strip()) >= 12]
    human_words = ("人", "老师", "教师", "学生", "孩子", "用户", "读者", "家庭", "团队", "课堂", "教室", "清晨", "行动", "对话")

    def score(sentence: str) -> tuple[int, int]:
        human_score = sum(1 for word in human_words if word in sentence)
        penalty = 1 if re.search(r"\d|参数|模型|字段|接口|算法|数据", sentence) else 0
        length_score = min(len(sentence), 90)
        return (human_score - penalty, length_score)

    candidates.sort(key=score, reverse=True)
    selected = [c for c in candidates[:2] if score(c)[0] >= 0]
    if not selected:
        return "把这段内容转译成一个有人物、有环境、有动作的生活化场景。"
    return "；".join(selected)[:180]


def build_prompt(title: str, label: str, excerpt: str, size: str) -> str:
    brief = visual_brief(title, label, excerpt)
    direction = SECTION_DIRECTIONS.get(label, "把文章片段转译成清晰的故事化场景。")
    return (
        f"请为一篇中文文章的{label}生成一张配图，构图比例适配 {size}。\n"
        f"文章标题：{title}\n"
        f"配图方向：{direction}\n"
        f"核心画面线索：{brief}\n"
        f"参考片段：{excerpt}\n"
        "注意：参考片段只用于理解内容，不要把片段中的任何词语、字母、数字或标签画进画面。\n\n"
        "创作要求：\n"
        f"- {STYLE_RULES}\n"
        "- 用一个清晰的生活化或故事化场景表达这段文字的核心意思，不要逐字复刻文章、表格或技术词。\n"
        "- 所有纸张、屏幕、便签、文件夹和书本都保持无字，只用图标、色块、线条和简单几何表示信息。\n"
        "- 画面可以有人物、室内外空间、书本、清晨、对话、行动中的细节等，但主体必须一眼能看懂。\n"
        f"- {TEXT_RULES}\n"
        f"- {NEGATIVE_RULES}"
    )


def request_json(method: str, url: str, api_key: str, payload: dict[str, Any] | None = None, timeout: int = 90) -> dict[str, Any]:
    data = None
    headers = {"Authorization": f"Bearer {api_key}"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise ApimartError(f"HTTP {exc.code} from APIMart: {detail}") from exc
    except urllib.error.URLError as exc:
        raise ApimartError(f"Network error calling APIMart: {exc.reason}") from exc

    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise ApimartError(f"APIMart returned non-JSON response: {body[:500]}") from exc


def submit_task(base_url: str, api_key: str, model: str, prompt: str, size: str, resolution: str, official_fallback: bool) -> str:
    payload: dict[str, Any] = {
        "model": model,
        "prompt": prompt,
        "size": size,
        "n": 1,
        "resolution": resolution,
    }
    if official_fallback and not model.endswith("-official"):
        payload["official_fallback"] = True

    response = request_json("POST", f"{base_url.rstrip('/')}/images/generations", api_key, payload)
    try:
        task_id = response["data"][0]["task_id"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ApimartError(f"Unexpected submit response: {json.dumps(response, ensure_ascii=False)[:800]}") from exc
    return task_id


def poll_task(base_url: str, api_key: str, task_id: str, poll_interval: int, timeout_seconds: int) -> dict[str, Any]:
    deadline = time.time() + timeout_seconds
    encoded = urllib.parse.quote(task_id, safe="")
    url = f"{base_url.rstrip('/')}/tasks/{encoded}?language=zh"

    while True:
        response = request_json("GET", url, api_key)
        data = response.get("data", {})
        status = data.get("status")
        progress = data.get("progress")
        print(f"Task {task_id}: {status or 'unknown'} {progress if progress is not None else ''}".strip(), file=sys.stderr)

        if status == "completed":
            return data
        if status in {"failed", "cancelled"}:
            raise ApimartError(f"Task {task_id} ended with status {status}: {json.dumps(data.get('error', data), ensure_ascii=False)}")
        if time.time() >= deadline:
            raise ApimartError(f"Timed out waiting for task {task_id}.")
        time.sleep(poll_interval)


def first_image_url(task_data: dict[str, Any]) -> tuple[str, int | None]:
    images = task_data.get("result", {}).get("images", [])
    if not images:
        raise ApimartError(f"Completed task has no images: {json.dumps(task_data, ensure_ascii=False)[:800]}")
    first = images[0]
    url_value = first.get("url")
    if isinstance(url_value, list):
        url = url_value[0] if url_value else ""
    else:
        url = url_value or ""
    if not isinstance(url, str) or not url:
        raise ApimartError(f"Completed task image URL is missing: {json.dumps(first, ensure_ascii=False)[:800]}")
    expires_at = first.get("expires_at")
    return url, expires_at if isinstance(expires_at, int) else None


def extension_from_url(url: str) -> str:
    path = urllib.parse.urlparse(url).path
    suffix = Path(path).suffix.lower()
    if suffix in {".png", ".jpg", ".jpeg", ".webp"}:
        return ".jpg" if suffix == ".jpeg" else suffix
    return ".png"


def download_image(url: str, output_path: Path, timeout: int = 180) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "article-illustration-skill/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            output_path.write_bytes(resp.read())
    except urllib.error.URLError as exc:
        raise ApimartError(f"Failed to download generated image: {exc.reason}") from exc


def write_manifest(path: Path, manifest: dict[str, Any]) -> None:
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_completed_items(manifest_path: Path) -> dict[str, dict[str, Any]]:
    if not manifest_path.exists():
        return {}
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}

    completed: dict[str, dict[str, Any]] = {}
    for item in manifest.get("items", []):
        if not isinstance(item, dict):
            continue
        key = item.get("key")
        output_path = item.get("output_path")
        if item.get("status") != "completed" or not isinstance(key, str) or not isinstance(output_path, str):
            continue
        if Path(output_path).exists():
            completed[key] = item
    return completed


def parse_env_value(raw: str) -> str:
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        value = value[1:-1]
    return value


def load_env_file(path: Path) -> bool:
    if not path.exists():
        return False
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key and key not in os.environ:
            os.environ[key] = parse_env_value(value)
    return True


def env_file_candidates(article_arg: str, explicit_env_file: str | None) -> list[Path]:
    candidates: list[Path] = []
    if explicit_env_file:
        candidates.append(Path(explicit_env_file).expanduser())
    if article_arg != "-":
        candidates.append(Path(article_arg).resolve().parent / ".apimart.env")
    candidates.append(Path.cwd() / ".apimart.env")

    deduped: list[Path] = []
    seen: set[Path] = set()
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved not in seen:
            deduped.append(resolved)
            seen.add(resolved)
    return deduped


def load_env_files(article_arg: str, explicit_env_file: str | None) -> list[str]:
    loaded: list[str] = []
    for candidate in env_file_candidates(article_arg, explicit_env_file):
        if load_env_file(candidate):
            loaded.append(str(candidate))
    return loaded


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate exactly three article illustrations with APIMart.")
    parser.add_argument("article", help="Article file path, or '-' to read from stdin.")
    parser.add_argument("--output-dir", default=None, help="Directory for images and manifest. Defaults to article sibling article-illustrations/.")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--size", default="16:9", choices=["auto", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"])
    parser.add_argument("--resolution", default="2K", choices=["1K", "2K", "4K"])
    parser.add_argument("--base-url", default=os.environ.get("APIMART_BASE_URL", DEFAULT_BASE_URL))
    parser.add_argument("--api-key-env", default="APIMART_API_KEY", help="Environment variable that stores the APIMart API key.")
    parser.add_argument("--env-file", default=None, help="Optional env file containing APIMART_API_KEY=...")
    parser.add_argument("--official-fallback", action="store_true", help="Ask APIMart to use official channel fallback when supported.")
    parser.add_argument("--poll-interval", type=int, default=8)
    parser.add_argument("--timeout-seconds", type=int, default=900)
    parser.add_argument("--resume", action="store_true", help="Skip completed items already recorded in manifest.json.")
    parser.add_argument("--force", action="store_true", help="Regenerate selected items even when they are completed in manifest.json.")
    parser.add_argument("--only", action="append", choices=["front", "middle", "ending"], help="Generate only the selected key. Repeat to select more.")
    parser.add_argument("--dry-run", action="store_true", help="Only print section prompts and write manifest; do not call APIMart.")
    return parser.parse_args()


def default_output_dir(article_arg: str) -> Path:
    if article_arg == "-":
        return Path.cwd() / "article-illustrations"
    return Path(article_arg).resolve().parent / "article-illustrations"


def main() -> int:
    args = parse_args()
    article_text = read_article(args.article)
    title = extract_title(article_text)
    sections = section_texts(article_text)
    output_dir = Path(args.output_dir).resolve() if args.output_dir else default_output_dir(args.article)
    output_dir.mkdir(parents=True, exist_ok=True)

    created_at = dt.datetime.now(dt.timezone.utc).isoformat()
    manifest: dict[str, Any] = {
        "created_at": created_at,
        "article": None if args.article == "-" else str(Path(args.article).resolve()),
        "title": title,
        "model": args.model,
        "size": args.size,
        "resolution": args.resolution,
        "dry_run": bool(args.dry_run),
        "items": [],
    }

    prompts: list[dict[str, Any]] = []
    for key, filename, label, start, end in WINDOWS:
        excerpt = sections[key]
        prompt = build_prompt(title, label, excerpt, args.size)
        prompts.append(
            {
                "key": key,
                "filename": filename,
                "label": label,
                "window": [start, end],
                "excerpt": excerpt,
                "prompt": prompt,
            }
        )

    if args.dry_run:
        manifest["items"] = prompts
        write_manifest(output_dir / "manifest.json", manifest)
        print(json.dumps(manifest, ensure_ascii=False, indent=2))
        return 0

    api_key = os.environ.get(args.api_key_env)
    if not api_key:
        load_env_files(args.article, args.env_file)
        api_key = os.environ.get(args.api_key_env)
    if not api_key:
        searched = ", ".join(str(path) for path in env_file_candidates(args.article, args.env_file))
        raise SystemExit(f"Missing API key. Set {args.api_key_env} or add it to one of: {searched}")

    manifest_path = output_dir / "manifest.json"
    completed_items = load_completed_items(manifest_path) if args.resume else {}

    target_keys = set(args.only or [item["key"] for item in prompts])

    for item in prompts:
        if item["key"] not in target_keys:
            completed_item = completed_items.get(item["key"])
            if completed_item:
                manifest["items"].append(completed_item)
                write_manifest(manifest_path, manifest)
            continue

        completed_item = completed_items.get(item["key"])
        if completed_item and not args.force:
            manifest["items"].append(completed_item)
            write_manifest(manifest_path, manifest)
            print(f"Skipping {item['filename']} ({item['label']}), already completed", file=sys.stderr)
            continue

        print(f"Submitting {item['filename']} ({item['label']})", file=sys.stderr)
        task_id = submit_task(
            base_url=args.base_url,
            api_key=api_key,
            model=args.model,
            prompt=item["prompt"],
            size=args.size,
            resolution=args.resolution,
            official_fallback=args.official_fallback,
        )
        task_data = poll_task(args.base_url, api_key, task_id, args.poll_interval, args.timeout_seconds)
        image_url, expires_at = first_image_url(task_data)
        output_path = output_dir / f"{item['filename']}{extension_from_url(image_url)}"
        download_image(image_url, output_path)
        manifest_item = dict(item)
        manifest_item.update(
            {
                "task_id": task_id,
                "status": "completed",
                "output_path": str(output_path),
                "source_url": image_url,
                "expires_at": expires_at,
            }
        )
        manifest["items"].append(manifest_item)
        write_manifest(manifest_path, manifest)
        print(f"Saved {output_path}", file=sys.stderr)

    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ApimartError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1)
