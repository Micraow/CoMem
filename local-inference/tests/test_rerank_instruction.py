"""rerank prompt 拼装的回归测试。

只测纯函数，**不加载 639MB 的模型**：`_format()` 的行为取决于模板拼装，而模板
是字符串。模型加载路径由 `/health` 的集成验证覆盖（README「rerank instruction」）。

跑法：

    cd local-inference && .venv/bin/python -m unittest discover tests
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backends.llama_cpp import (  # noqa: E402 - 先插 sys.path 再 import
    replace_rerank_instruction,
    render_rerank_prompt,
)
from server import _echo_instruction  # noqa: E402

#: `ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF` 里的 `tokenizer.chat_template.rerank`，
#: 逐字节抄自 GGUF 元数据（见 local/notes/rerank-instruction.md）。
TEMPLATE = (
    "<|im_start|>system\n"
    "Judge whether the Document meets the requirements based on the Query and the "
    'Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n'
    "<|im_start|>user\n"
    "<Instruct>: Given a web search query, retrieve relevant passages that answer "
    "the query\n"
    "<Query>: {query}\n"
    "<Document>: {document}<|im_end|>\n"
    "<|im_start|>assistant\n<think>\n\n</think>\n\n"
)

INSTRUCTION = "Given a web search query, retrieve relevant passages that answer the query"


class RenderRerankPromptTest(unittest.TestCase):
    def test_replaces_both_placeholders(self) -> None:
        prompt = render_rerank_prompt(TEMPLATE, "查询", "正文")
        self.assertIn("<Query>: 查询\n", prompt)
        self.assertIn("<Document>: 正文<|im_end|>", prompt)
        self.assertNotIn("{query}", prompt)
        self.assertNotIn("{document}", prompt)

    def test_query_with_literal_document_is_not_replaced(self) -> None:
        """回归：query 里的字面量 `{document}` 不能被换成正文。

        顺序两次 `str.replace`（`{query}` 先、`{document}` 后）会命中刚插入的
        query 文本，把 `{document}` 换成文档正文（上游 issue #30816）。
        """
        prompt = render_rerank_prompt(TEMPLATE, "解释 {document} 这个占位符", "文档正文")
        self.assertIn("<Query>: 解释 {document} 这个占位符", prompt)
        self.assertIn("<Document>: 文档正文<|im_end|>", prompt)

    def test_document_with_literal_query_is_not_replaced(self) -> None:
        """反向：文档正文里的 `{query}` 同样原样保留（单遍扫描两个方向都成立）。"""
        prompt = render_rerank_prompt(TEMPLATE, "查询", "看到 {query} 原样保留")
        self.assertIn("<Query>: 查询\n", prompt)
        self.assertIn("<Document>: 看到 {query} 原样保留", prompt)


class ReplaceInstructionTest(unittest.TestCase):
    def test_replaces_only_the_instruction_line(self) -> None:
        replaced = replace_rerank_instruction(TEMPLATE, "自定义文本")
        self.assertIsNotNone(replaced)
        assert replaced is not None  # for type checkers
        self.assertIn("<Instruct>: 自定义文本\n", replaced)
        self.assertNotIn(INSTRUCTION, replaced)
        # 模板其余部分逐字不变
        self.assertIn("<Query>: {query}\n<Document>: {document}", replaced)

    def test_missing_instruction_line_returns_none(self) -> None:
        """没有 `<Instruct>:` 行时不能假装生效——`/health` 要能报 null。"""
        self.assertIsNone(replace_rerank_instruction("<Query>: {query}", "自定义"))

    def test_instruction_with_backslash_is_literal(self) -> None:
        """instruction 是任意文本：`\\1` 不能被 `re.sub` 当成组引用。"""
        replaced = replace_rerank_instruction(TEMPLATE, r"路径 C:\1 的原样文本")
        assert replaced is not None
        self.assertIn(r"<Instruct>: 路径 C:\1 的原样文本", replaced)

    def test_instruction_changes_the_scored_prompt(self) -> None:
        """同一个 query + document，改 instruction 后 prompt 必然不同。"""
        baseline = render_rerank_prompt(TEMPLATE, "q", "d")
        replaced = replace_rerank_instruction(TEMPLATE, "另一句")
        assert replaced is not None
        self.assertNotEqual(render_rerank_prompt(replaced, "q", "d"), baseline)


class HealthInstructionEchoTest(unittest.TestCase):
    def test_truncates_to_80_chars(self) -> None:
        self.assertEqual(len(_echo_instruction("x" * 200) or ""), 80)

    def test_none_stays_none(self) -> None:
        self.assertIsNone(_echo_instruction(None))

    def test_short_instruction_unchanged(self) -> None:
        self.assertEqual(_echo_instruction("短句"), "短句")


if __name__ == "__main__":
    unittest.main()
