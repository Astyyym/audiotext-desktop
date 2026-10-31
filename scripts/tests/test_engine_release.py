"""Release regressions through cli.main, using real temporary output files.

Run with: python -B scripts/tests/test_engine_release.py
Only the Whisper model and audio decoding/probing boundaries are mocked;
argument parsing, transcription adapter, output writers and JSON events are real.
No faster-whisper installation, model weights, ffmpeg or GUI is required.
"""
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

# Keep the real engine.transcribe adapter while avoiding the optional heavy import.
whisper_stub = types.ModuleType("faster_whisper")
whisper_stub.WhisperModel = mock.Mock(name="WhisperModel")
with mock.patch.dict(sys.modules, {"faster_whisper": whisper_stub}):
    from engine import cli


class EngineReleaseTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="atd-engine-release-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.model_dir = self.root / "model"
        self.model_dir.mkdir()
        self.out = self.root / "out"
        self.out.mkdir()
        self.decode_dir = self.root / "decoded"
        self.decode_dir.mkdir()
        self.decoded_count = 0
        self.text = "这是一段用于验证输出保护的演示文字。"
        self.model = mock.Mock(name="local_whisper_model")
        self.model.transcribe.side_effect = self.transcribe_fixture
        patches = [
            mock.patch.object(cli.transcribe, "WhisperModel", return_value=self.model),
            mock.patch.object(cli.audio, "probe_duration", return_value=3.0),
            mock.patch.object(cli.audio, "to_wav16k", side_effect=self.decode_fixture),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def decode_fixture(self, _source):
        self.decoded_count += 1
        wav = self.decode_dir / f"decoded-{self.decoded_count}.wav"
        wav.write_bytes(b"mock decoded audio")
        return str(wav)

    def transcribe_fixture(self, _wav, **kwargs):
        segments = [types.SimpleNamespace(start=0.0, end=2.0, text=self.text)]
        # Automatic detection reports a real language, never the sentinel "auto".
        info = types.SimpleNamespace(language=kwargs["language"] or "en", language_probability=0.99)
        return iter(segments), info

    def input_file(self, directory="input-a", name="meeting.wav"):
        folder = self.root / directory
        folder.mkdir(exist_ok=True)
        source = folder / name
        source.write_bytes(b"mock source audio")
        return source

    def invoke(self, source, *, language="zh", formats="txt,srt"):
        stream = io.StringIO()
        with contextlib.redirect_stdout(stream):
            code = cli.main([
                "transcribe", "--input", str(source), "--out", str(self.out),
                "--model", str(self.model_dir), "--device", "cpu",
                "--lang", language, "--formats", formats, "--progress-json",
            ])
        events = [json.loads(line) for line in stream.getvalue().splitlines() if line.strip()]
        return code, events

    def done(self, source, **kwargs):
        code, events = self.invoke(source, **kwargs)
        self.assertEqual(code, 0, events)
        done = [event for event in events if event["type"] == "done"]
        self.assertEqual(len(done), 1, events)
        self.assertFalse(any(event["type"] == "error" for event in events), events)
        return {fmt: Path(path) for fmt, path in done[0]["outputs"].items()}

    def test_rerun_preserves_existing_txt_srt_and_uses_next_shared_number(self):
        source = self.input_file()
        old_txt = self.out / "meeting.txt"
        old_srt = self.out / "meeting.srt"
        old_txt.write_bytes(b"existing edited transcript\r\n")
        old_srt.write_bytes(b"existing edited subtitles\r\n")
        first = self.done(source)
        first_contents = {fmt: path.read_bytes() for fmt, path in first.items()}
        second = self.done(source)
        self.assertEqual({path.stem for path in first.values()}, {"meeting (1)"})
        self.assertEqual({path.stem for path in second.values()}, {"meeting (2)"})
        self.assertEqual(old_txt.read_bytes(), b"existing edited transcript\r\n")
        self.assertEqual(old_srt.read_bytes(), b"existing edited subtitles\r\n")
        for fmt, path in first.items():
            self.assertEqual(path.read_bytes(), first_contents[fmt])

    def test_different_sources_with_same_basename_keep_distinct_contents(self):
        source_a = self.input_file("input-a")
        source_b = self.input_file("input-b")
        self.text = "第一份演示录音。"
        first = self.done(source_a)
        first_contents = {fmt: path.read_bytes() for fmt, path in first.items()}
        self.text = "第二份演示录音。"
        second = self.done(source_b)
        self.assertEqual({path.stem for path in first.values()}, {"meeting"})
        self.assertEqual({path.stem for path in second.values()}, {"meeting (1)"})
        self.assertTrue(set(first.values()).isdisjoint(second.values()))
        for fmt, path in first.items():
            self.assertEqual(path.read_bytes(), first_contents[fmt])
        self.assertIn("第一份", first["txt"].read_text(encoding="utf-8-sig"))
        self.assertIn("第二份", second["txt"].read_text(encoding="utf-8-sig"))

    def test_all_formats_share_stem_when_only_one_existing_format_conflicts(self):
        source = self.input_file()
        existing = self.out / "meeting.srt"
        existing.write_bytes(b"keep these subtitles")
        outputs = self.done(source, formats="txt,srt,md,json")
        self.assertEqual(set(outputs), {"txt", "srt", "md", "json"})
        self.assertEqual({path.stem for path in outputs.values()}, {"meeting (1)"})
        self.assertTrue(all(path.is_file() and path.stat().st_size > 0 for path in outputs.values()))
        self.assertEqual(existing.read_bytes(), b"keep these subtitles")
        self.assertFalse((self.out / "meeting.txt").exists())
        document = json.loads(outputs["json"].read_text(encoding="utf-8"))
        self.assertEqual(document["meta"]["source"], str(source))
        self.assertEqual(document["segments"][0]["text"], self.text)
        self.assertIn("00:00:00,000 --> 00:00:02,000", outputs["srt"].read_text(encoding="utf-8"))

    def test_existing_unrequested_format_still_reserves_its_original_group(self):
        source = self.input_file()
        original = self.out / "meeting.json"
        original.write_bytes(b'{"existing":"metadata"}')
        outputs = self.done(source, formats="txt")
        self.assertEqual(outputs["txt"].name, "meeting (1).txt")
        self.assertEqual(original.read_bytes(), b'{"existing":"metadata"}')

    def test_auto_language_reaches_model_as_none_and_exports_detected_language(self):
        outputs = self.done(self.input_file(), language="auto", formats="txt,json")
        self.assertIsNone(self.model.transcribe.call_args.kwargs["language"])
        document = json.loads(outputs["json"].read_text(encoding="utf-8"))
        self.assertEqual(document["meta"]["language"], "en")

    def test_explicit_zh_and_en_languages_are_unchanged(self):
        source = self.input_file()
        for language in ("zh", "en"):
            with self.subTest(language=language):
                outputs = self.done(source, language=language, formats="txt,json")
                self.assertEqual(self.model.transcribe.call_args.kwargs["language"], language)
                document = json.loads(outputs["json"].read_text(encoding="utf-8"))
                self.assertEqual(document["meta"]["language"], language)

    def test_empty_language_keeps_automatic_detection_behavior(self):
        self.done(self.input_file(), language="", formats="txt")
        self.assertIsNone(self.model.transcribe.call_args.kwargs["language"])

    def test_writer_error_preserves_old_outputs_and_releases_new_group_for_retry(self):
        source = self.input_file()
        original = self.out / "meeting.txt"
        original.write_bytes(b"keep edited transcript")
        with mock.patch.object(cli.formats, "write_srt", side_effect=OSError("simulated disk failure")):
            code, events = self.invoke(source, formats="txt,srt,json")
        self.assertEqual(code, 1)
        self.assertEqual(events[-1]["type"], "error")
        self.assertIn("simulated disk failure", events[-1]["message"])
        self.assertEqual(original.read_bytes(), b"keep edited transcript")
        self.assertEqual(set(self.out.iterdir()), {original})
        outputs = self.done(source, formats="txt,srt,json")
        self.assertEqual({path.stem for path in outputs.values()}, {"meeting (1)"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
