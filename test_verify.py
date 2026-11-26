"""Offline regressions for the local Valkey replacement check."""

import os
import unittest
from subprocess import CompletedProcess
from unittest.mock import patch

from verify import Lab, require_recovered_value, validate_replacement_plan

HOST = "unix:///tmp/selected-docker.sock"
ADDRESS = "172.19.0.3"
LOADING = CompletedProcess([], 1, "", "LOADING Valkey is loading the dataset in memory\n")


class ReplacementTests(unittest.TestCase):
    @staticmethod
    def plan(*changes, errored=False):
        return {"errored": errored, "resource_changes": [
            {"address": address, "change": {"actions": actions}} for address, actions in changes
        ]}

    def test_plan_allows_only_the_creates_for_each_mode(self):
        server = ("docker_container.valkey", ["create"])
        empty = ("docker_volume.empty[0]", ["create"])
        original = ("docker_volume.data", ["no-op"])
        self.assertEqual(validate_replacement_plan(self.plan(original, server), wrong_volume=False),
                         [server[0]])
        self.assertEqual(validate_replacement_plan(self.plan(empty, original, server), wrong_volume=True),
                         [server[0], empty[0]])

    def test_plan_rejects_unexpected_actions_in_either_mode(self):
        server = ("docker_container.valkey", ["create"])
        empty = ("docker_volume.empty[0]", ["create"])
        moved = self.plan(server, ("docker_volume.data", ["no-op"]))
        moved["resource_changes"][1]["previous_address"] = "docker_volume.old"
        imported = self.plan(server, ("docker_volume.data", ["no-op"]))
        imported["resource_changes"][1]["change"]["importing"] = {"id": "synthetic-volume"}
        for wrong_volume, plan in (
            (False, self.plan(server, empty)),
            (False, self.plan((server[0], ["delete", "create"]))),
            (False, self.plan(server, errored=True)),
            (False, dict(self.plan(server), deferred_changes=[{"reason": "deferred_prereq"}])),
            (False, dict(self.plan(server), output_changes={"new_output": {"actions": ["create"]}})),
            (False, moved),
            (False, imported),
            (True, self.plan(server)),
            (True, self.plan(empty)),
            (True, self.plan(server, empty, empty)),
            (True, self.plan(server, empty, ("docker_volume.data", ["delete"]))),
            (True, self.plan(server, empty, ("docker_network.run", ["update"]))),
        ):
            with self.subTest(wrong_volume=wrong_volume, plan=plan):
                with self.assertRaisesRegex(RuntimeError, "Refusing replacement plan"):
                    validate_replacement_plan(plan, wrong_volume=wrong_volume)

    def test_get_null_is_missing_but_a_different_string_is_a_mismatch(self):
        for raw, diagnosis in (('["PONG",null]', "KEY_MISSING"),
                               ('["PONG","synthetic:other"]', "VALUE_MISMATCH"),
                               ('["PONG",""]', "VALUE_MISMATCH")):
            with self.subTest(raw=raw):
                reply = Lab.reply(CompletedProcess([], 0, raw, ""))
                with self.assertRaisesRegex(RuntimeError, f"^After: PONG; GET={diagnosis}$"):
                    require_recovered_value(reply, "synthetic:expected")
        require_recovered_value(["PONG", "synthetic:expected"], "synthetic:expected")
        with self.assertRaisesRegex(RuntimeError, "^Expected PONG and GET reply$"):
            require_recovered_value(["unexpected", None], "synthetic:expected")

    def test_absence_check_detects_the_empty_volume_even_without_a_label(self):
        with (patch.dict(os.environ, {}, clear=True), patch("verify.local_docker", return_value=HOST)):
            lab = Lab(wrong_volume=True)
        with patch.object(lab, "resources", side_effect=lambda kind, owned=False:
                          [lab.empty_volume] if kind == "volume" and not owned else []):
            with self.assertRaisesRegex(RuntimeError, "volume still exists"):
                lab.assert_absent()


class VerifyTests(unittest.TestCase):
    def test_cli_and_provider_use_only_the_selected_socket(self):
        with (patch.dict(os.environ, {"DOCKER_CONTEXT": "local", "DOCKER_HOST": "tcp://ignored:2375"}, clear=True),
              patch("verify.Path.is_socket", return_value=True) as is_socket,
              patch("verify.run") as run,
              patch.object(Lab, "init")):
            run.side_effect = [CompletedProcess([], 0, HOST + "\n", ""), None, RuntimeError("stop at apply")]
            lab = Lab()
            lab.docker("info")
            with self.assertRaisesRegex(RuntimeError, "stop at apply"):
                lab.scenario()

        select, cli, apply = run.call_args_list
        is_socket.assert_called_once_with()
        self.assertEqual(select.args[0][-1], "local")
        self.assertEqual(cli.args[0], ["docker", "--host", HOST, "info"])
        self.assertEqual(apply.args[0][2], "apply")
        self.assertIn(f"-var=docker_host={HOST}", apply.args[0])
        for call in (cli, apply):
            unexpected_keys = {"DOCKER_CONTEXT", "DOCKER_HOST"}.intersection(call.kwargs["env"])
            self.assertEqual(unexpected_keys, set())

    def test_loading_retries_with_the_remaining_budget(self):
        pong = CompletedProcess([], 0, '"PONG"\n', "")
        with (patch("verify.local_docker", return_value=HOST),
              patch.object(Lab, "cli", side_effect=[LOADING, pong]) as cli,
              patch("verify.time.monotonic", side_effect=[100, 101, 102, 103]),
              patch("verify.time.sleep")):
            self.assertEqual(Lab().ready(ADDRESS, 105, "PING"), "PONG")
        self.assertEqual([call.kwargs["timeout"] for call in cli.call_args_list], [5, 3])

    def test_loading_does_not_extend_deadline(self):
        with (patch("verify.local_docker", return_value=HOST),
              patch.object(Lab, "cli", return_value=LOADING) as cli,
              patch("verify.time.monotonic", side_effect=[100, 105, 105]),
              patch("verify.time.sleep")):
            with self.assertRaises(TimeoutError):
                Lab().ready(ADDRESS, 105, "PING")
        cli.assert_called_once_with(ADDRESS, "PING", timeout=5)

    def test_other_server_error_is_not_retried(self):
        denied = CompletedProcess([], 1, "", "NOPERM denied\n")
        with (patch("verify.local_docker", return_value=HOST),
              patch.object(Lab, "cli", return_value=denied) as cli,
              patch("verify.time.monotonic", return_value=100)):
            with self.assertRaisesRegex(RuntimeError, "NOPERM denied"):
                Lab().ready(ADDRESS, 105, "PING")
        cli.assert_called_once_with(ADDRESS, "PING", timeout=5)
