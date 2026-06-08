---
name: 插画格配图生成skill
description: 为已完成的中文文章生成内容平台配图。读取文章全文，按前30%、中间30%、最后30%提炼三个配图场景，调用 APIMart 的 gemini-3-pro-image-preview 图像模型生成3张温暖、亲和、有故事感的手绘漫画风插画；适用于文章配图、公众号/小红书/知识平台插图、中文内容封面和段落配图。
---

# 插画格配图生成skill

## 目标

当用户写完一篇文章并要求“配图”“文章插画”“生成文章配图”“用插画格配图生成skill”等，生成且只生成 3 张图片：

1. `01-front`：文章前 30% 的核心场景。
2. `02-middle`：文章中间 30% 的核心场景。
3. `03-ending`：文章最后 30% 的核心场景。

图片统一为手绘漫画风格：温暖、亲和、有故事感，不偏写实，不偏赛博朋克，适合内容平台配图。画面干净，主体清晰。默认要求画面不要出现文字；如不可避免，必须使用简体中文。

## 不要做的事

- 不要生成超过或少于 3 张。
- 不要把 APIMart API key 写进源码、`SKILL.md`、manifest、命令输出或最终回复。只允许放在本机私有 `.apimart.env` 中，并确保文件权限为 `600`。
- 不要只返回 APIMart 临时图片链接；生成链接有效期有限，必须下载归档。
- 不要机械把文章切成三段后直接塞给模型；先提炼每段的画面主题。
- 不要生成写实摄影、3D 渲染、赛博朋克、黑暗惊悚、复杂海报、英文伪文字、乱码、水印、logo。

## 默认参数

- API key：优先读取环境变量 `APIMART_API_KEY`；也可从文章同级或当前目录的私有 `.apimart.env` 读取
- API base URL：`https://api.apimart.ai/v1`
- 模型：`gemini-3-pro-image-preview`
- 数量：每个场景 `n=1`，共 3 个任务
- 尺寸：默认 `16:9`；用户明确要方图时用 `1:1`
- 分辨率：默认 `2K`；草稿或控成本时用 `1K`
- 输出目录：文章同级的 `article-illustrations/`，或用户指定目录

> 注意：用户可能把 Nano Banana 2 和模型名混说。实际调用以模型 ID `gemini-3-pro-image-preview` 为准；它在 APIMart 文档中对应 Gemini-3-Pro-Image-preview。

## 工作流

### 1. 确认输入

优先使用用户给出的文章文件。如果用户只粘贴正文，把正文保存到临时文件或通过 stdin 传给脚本。缺少 API key 时，不要要求用户把 key 再发到聊天里；提醒用户在本机设置：

```bash
export APIMART_API_KEY="你的 APIMart key"
```

如果用户明确要求“写进去”，只写入本机私有 `.apimart.env`：

```bash
APIMART_API_KEY=你的 Apimart key
```

不要把真实 key 展示在回复中。

### 2. 先 dry-run 审稿

除非用户明确要求立刻生成，先运行 dry-run 看三段切分和提示词：

```bash
python3 <SKILL_ROOT>/scripts/generate_article_illustrations.py \
  path/to/article.md \
  --output-dir path/to/article-illustrations \
  --dry-run
```

检查重点：

- 三段是否真的覆盖文章的起、承、收，而不是只按字数截断。
- 每张图的主体是否清晰，有可视化场景。
- 提示词是否约束了中文、手绘漫画、温暖亲和、无英文伪字。

### 3. 生成图片

确认提示词可用后运行：

```bash
python3 <SKILL_ROOT>/scripts/generate_article_illustrations.py \
  path/to/article.md \
  --output-dir path/to/article-illustrations \
  --size 16:9 \
  --resolution 2K
```

脚本会：

1. 提交 3 个图像生成任务。
2. 轮询 `/v1/tasks/{task_id}?language=zh`。
3. 成功后下载图片。
4. 写出 `manifest.json`，记录文章切分、提示词、task_id、下载路径和过期时间。

如果生成中途网络断开，重新运行时加 `--resume`，脚本会跳过 manifest 中已经完成且本地文件存在的图片，只补缺失项。

如果某一张图不合格，只重刷该图：

```bash
python3 <SKILL_ROOT>/scripts/generate_article_illustrations.py \
  path/to/article.md \
  --output-dir path/to/article-illustrations \
  --resume \
  --only middle \
  --force
```

### 4. 质量检查

交付前逐张检查：

- 是否正好 3 张：`01-front.png`、`02-middle.png`、`03-ending.png`。
- 是否分别贴合前段、中段、尾段内容。
- 是否是温暖手绘漫画风，而不是写实/赛博朋克/海报堆字。
- 是否没有英文、乱码、错误中文、奇怪水印。
- 如果图片文字出错，重试时把提示词改为“画面中不要出现任何文字”。

## 提示词原则

每张图的提示词保持短而具体，包含：

- 用途：文章第几段配图。
- 场景：人物、地点、动作、关系或象征物。
- 情绪：温暖、亲和、有故事感。
- 风格：手绘漫画、干净构图、主体清晰。
- 文字约束：默认不要出现文字；如必须出现，只能中文。

不要把整篇文章塞进一张图的提示词。每张图只使用对应片段的核心信息。

## API 参考

APIMart 图像接口细节见 `references/apimart-image-api.md`。需要修改脚本或排查错误时再读取该文件。
