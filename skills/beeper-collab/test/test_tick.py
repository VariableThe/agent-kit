"""Unit tests for beeper-collab tick mode (stdlib unittest, no network).

Covers classify_inbound, guard_tick_reply, and the assistant-footer append
helper that the shared send path applies exactly once.
"""

import importlib.util
import os
import unittest

_SCRIPT = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "scripts",
    "beeper_collab.py"))

_spec = importlib.util.spec_from_file_location("beeper_collab", _SCRIPT)
bc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bc)


class ClassifyInboundTest(unittest.TestCase):
    def test_ok_thanks_is_ack(self):
        self.assertEqual(bc.classify_inbound("ok thanks"), "ACK")

    def test_haan_theek_hai_is_ack(self):
        self.assertEqual(bc.classify_inbound("haan theek hai"), "ACK")

    def test_yesno_question(self):
        self.assertEqual(bc.classify_inbound("is the repo set up?"), "YESNO")

    def test_open_question(self):
        self.assertEqual(
            bc.classify_inbound("who is presenting next week?"),
            "OPEN_QUESTION")

    def test_commitment_by_tomorrow(self):
        self.assertEqual(
            bc.classify_inbound("finish your part by tomorrow"), "COMMITMENT")

    def test_share_link_is_request(self):
        self.assertEqual(bc.classify_inbound("share the link"), "REQUEST")

    def test_cool_thumb_up_is_ack(self):
        self.assertEqual(bc.classify_inbound("cool \U0001f44d"), "ACK")

    def test_precedence_commitment_beats_question(self):
        self.assertEqual(
            bc.classify_inbound("can you finish by tomorrow?"), "COMMITMENT")

    def test_empty_is_other(self):
        self.assertEqual(bc.classify_inbound(""), "OTHER")


class GuardTickReplyTest(unittest.TestCase):
    def test_allows_ack_batch(self):
        res = bc.guard_tick_reply("noted", {"ACK"}, 0)
        self.assertTrue(res["allowed"], res)
        self.assertEqual(res["reason"], "ok")

    def test_allows_yesno_batch(self):
        res = bc.guard_tick_reply("yes", {"YESNO"}, 0)
        self.assertTrue(res["allowed"], res)

    def test_denies_mixed_classes(self):
        res = bc.guard_tick_reply("ok", {"ACK", "YESNO"}, 0)
        self.assertFalse(res["allowed"])
        self.assertIn("policy", res["reason"])
        self.assertIn("ACK", res["reason"])

    def test_denies_non_ack_or_yesno_class(self):
        res = bc.guard_tick_reply("ok", {"OTHER"}, 0)
        self.assertFalse(res["allowed"])

    def test_denies_url(self):
        res = bc.guard_tick_reply("see https://example.com/pr", {"ACK"}, 0)
        self.assertFalse(res["allowed"])
        self.assertIn("denied pattern", res["reason"])

    def test_denies_deadline_phrase(self):
        res = bc.guard_tick_reply("yes, done by tomorrow", {"ACK"}, 0)
        self.assertFalse(res["allowed"])
        self.assertIn("tomorrow", res["reason"])

    def test_denies_over_160_chars(self):
        res = bc.guard_tick_reply("a" * 161, {"ACK"}, 0)
        self.assertFalse(res["allowed"])
        self.assertIn("160", res["reason"])

    def test_denies_over_two_lines(self):
        res = bc.guard_tick_reply("line one\nline two\nline three", {"ACK"}, 0)
        self.assertFalse(res["allowed"])

    def test_denies_when_hourly_cap_reached(self):
        res = bc.guard_tick_reply("ok", {"ACK"}, 4)
        self.assertFalse(res["allowed"])
        self.assertIn("rate limit", res["reason"])


class DisclosureAppendTest(unittest.TestCase):
    """The footer is appended exactly once by the shared send path (pure)."""

    def test_appends_once(self):
        text = bc.append_disclosure("hi")
        self.assertEqual(text, "hi" + bc.AI_DISCLOSURE)
        self.assertEqual(text.count(bc.AI_DISCLOSURE), 1)

    def test_idempotent(self):
        suffixed = "hi" + bc.AI_DISCLOSURE
        self.assertEqual(bc.append_disclosure(suffixed), suffixed)
        self.assertEqual(suffixed.count(bc.AI_DISCLOSURE), 1)

    def test_nested_append_still_once(self):
        self.assertEqual(
            bc.append_disclosure(bc.append_disclosure("x")),
            bc.append_disclosure("x"))


if __name__ == "__main__":
    unittest.main()
