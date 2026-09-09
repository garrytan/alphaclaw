"""Hermetic checks; never reads or mutates the host's cgroup hierarchy.

Run: python3 -B tests/scripts/test_prepare_cloud_cgroups.py
"""

import copy
import errno
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[2] / "scripts/dev/prepare-cloud-cgroups.py"
SPEC = importlib.util.spec_from_file_location("prepare_cloud_cgroups", SCRIPT)
repair = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(repair)


def original_groups():
    groups = {}
    for name in ("", *repair.CONDUCTOR):
        groups[name] = {
            "cgroup.type": "domain threaded" if not name else "threaded",
            "cgroup.subtree_control": "cpu" if name in ("", "conductor") else "",
            "cpu.max": {"conductor": "700000 100000", "conductor/workload": "600000 100000"}.get(name, "max 100000"),
            "cpu.weight": "10" if name == "conductor" else "100",
            "cpu.max.burst": "0", "cpu.idle": "0",
        }
    return groups


def prepared_groups():
    groups = original_groups()
    groups[""]["cgroup.type"] = "domain"
    groups[""]["cgroup.subtree_control"] = "cpu io memory pids"
    groups["conductor"]["cgroup.type"] = "domain threaded"
    for name in ("alphaclaw-host", "alphaclaw-docker"):
        groups[name] = {"cgroup.type": "domain", "cgroup.subtree_control": ""}
    return groups


def stat(tid, start):
    fields = ["S", "1", *(["0"] * 17), str(start)]
    return f"{tid} (a process ) with spaces) {' '.join(fields)}"


class CloudCgroupTests(unittest.TestCase):
    def test_exact_initial_layout_and_prepared_preconditions(self):
        self.assertEqual(repair.classify_layout(original_groups(), {1}), "original")
        self.assertEqual(repair.classify_layout(prepared_groups(), set()), "prepared")
        cases = []
        unknown = original_groups()
        unknown["other-workload"] = {}
        cases.append((unknown, {1}))
        missing_memory = prepared_groups()
        missing_memory[""]["cgroup.subtree_control"] = "cpu"
        cases.append((missing_memory, set()))
        cases.append((prepared_groups(), {1}))
        improper_leaf = prepared_groups()
        improper_leaf["conductor/workload"]["cgroup.type"] = "domain"
        cases.append((improper_leaf, set()))
        for groups, pids in cases:
            with self.subTest(groups=groups, pids=pids), self.assertRaises(RuntimeError):
                repair.classify_layout(groups, pids)

    def test_prepared_apply_is_read_only_even_without_root(self):
        with patch.object(repair, "topology", return_value=prepared_groups()), \
                patch.object(repair, "members", return_value=set()), \
                patch.object(repair.os, "geteuid", return_value=1000), \
                patch.object(repair, "Repair") as constructor, \
                patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(repair.main(["--apply"]), 0)
            constructor.assert_not_called()
            self.assertFalse(json.loads(output.getvalue())["changed"])

    def test_default_check_and_unknown_layout_never_construct_repair(self):
        with patch.object(repair, "topology", return_value=original_groups()) as topology, \
                patch.object(repair, "members", return_value={1}), \
                patch.object(repair, "Repair") as constructor, \
                patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(repair.main([]), 0)
            self.assertEqual(repair.main(["--check"]), 0)
            topology.return_value = {"": {"cgroup.type": "domain"}}
            with self.assertRaises(RuntimeError):
                repair.main(["--apply"])
            constructor.assert_not_called()

    def test_start_ticks_are_exact_and_identity_read_detects_reuse(self):
        parsed = repair.parse_stat(stat(100, "9007199254740993999"))
        self.assertEqual(parsed["start"], "9007199254740993999")
        with patch.object(repair, "read", side_effect=[stat(100, 1), "Tgid:\t100", stat(100, 2)]):
            self.assertIsNone(repair.identity(100))

    def test_process_and_thread_moves_check_exact_identity_and_errno(self):
        instance = repair.Repair(original_groups())
        before = {"tid": 100, "tgid": 100, "start": "1"}
        with patch.object(repair, "identity", return_value={**before, "start": "2"}), \
                patch.object(repair, "write") as write:
            self.assertFalse(instance.move("conductor", before))
            self.assertFalse(instance.move("conductor/workload", before, thread=True))
            write.assert_not_called()
        with patch.object(repair, "identity", return_value=before), \
                patch.object(repair, "write", side_effect=ProcessLookupError(errno.ESRCH, "exited")):
            self.assertFalse(instance.move("conductor", before))
        with patch.object(repair, "identity", return_value=before), \
                patch.object(repair, "write", side_effect=PermissionError(errno.EPERM, "denied")):
            with self.assertRaises(PermissionError):
                instance.move("conductor", before)

    def test_snapshot_rechecks_thread_after_reading_process_identity(self):
        instance = repair.Repair(original_groups())
        before = {"tid": 100, "tgid": 100, "start": "1"}
        reused = {**before, "start": "2"}
        with patch.object(repair, "identity", side_effect=[before, reused, reused]):
            instance.remember(100, "conductor/workload")
        self.assertFalse(instance.records)

    def test_leader_default_and_split_resource_domain_refusal(self):
        records = {
            (101, "2"): {"tid": 101, "tgid": 100, "start": "2", "processStart": "1", "group": "conductor/host-runtime"},
            (100, "1"): {"tid": 100, "tgid": 100, "start": "1", "processStart": "1", "group": "conductor/workload"},
        }
        self.assertEqual(repair.process_defaults(records), {(100, "1"): "conductor/workload"})
        repair.assert_no_split_domains(records)
        records[(101, "2")]["group"] = ""
        with self.assertRaises(RuntimeError):
            repair.assert_no_split_domains(records)

    def test_evidence_and_initial_snapshot_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "evidence"
            evidence = repair.Evidence(destination, {"original": True})
            evidence.append("discovered-threads.jsonl", {"tid": 1})
            with self.assertRaises(FileExistsError):
                evidence.save("before.json", {"original": False})
            with self.assertRaises(FileExistsError):
                repair.Evidence(destination, {})
            self.assertEqual(json.loads((destination / "before.json").read_text()), {"original": True})

    def test_domain_controllers_enabled_only_after_every_root_process_moves(self):
        instance = repair.Repair(original_groups())
        root_pids = {10, 20, 30}
        actions = []

        def move(group, item):
            actions.append(("move", group, item["tid"]))
            root_pids.discard(item["tid"])
            return True

        def write(path, value):
            if path.name == "cgroup.subtree_control" and path.parent == repair.ROOT:
                self.assertFalse(root_pids)
            actions.append(("write", str(path.relative_to(repair.ROOT)), value))

        with tempfile.TemporaryDirectory() as directory, \
                patch.object(repair, "ROOT", Path(directory)), \
                patch.object(repair.os, "getpid", return_value=10), \
                patch.object(repair, "identity", side_effect=lambda pid: {"tid": pid}), \
                patch.object(repair, "members", side_effect=lambda *args: set(root_pids)), \
                patch.object(instance, "move", side_effect=move), \
                patch.object(repair, "write", side_effect=write):
            instance.create_domains()
        self.assertEqual(actions[0], ("move", "alphaclaw-host", 10))
        self.assertIn(("write", "conductor/cpu.max", "700000 100000"), actions)
        self.assertIn(("write", "conductor/cpu.weight", "10"), actions)
        self.assertIn(("write", "conductor/workload/cpu.max", "600000 100000"), actions)

    def test_restore_preserves_mixed_threads_handles_fork_and_ignores_reused_pid(self):
        instance = repair.Repair(original_groups())
        identities = {tid: {"tid": tid, "tgid": 100 if tid in (101, 102, 103) else tid,
                            "start": str(tid), "ppid": 1} for tid in (100, 101, 102, 200, 400)}
        positions = {tid: "alphaclaw-host" for tid in identities}
        instance.records = {
            (100, "100"): {**identities[100], "processStart": "100", "group": "conductor/workload"},
            (101, "101"): {**identities[101], "processStart": "100", "group": "conductor/host-runtime"},
            (200, "old"): {**identities[200], "start": "old", "processStart": "old", "group": "conductor/workload"},
        }
        with tempfile.TemporaryDirectory() as directory:
            proc = Path(directory)
            for tid in identities:
                (proc / str(identities[tid]["tgid"]) / "task" / str(tid)).mkdir(parents=True, exist_ok=True)

            def members(group, kind="cgroup.threads"):
                tids = {tid for tid, position in positions.items() if position == group}
                return {identities[tid]["tgid"] for tid in tids} if kind == "cgroup.procs" else tids

            def move(group, item, *, thread=False):
                if not thread:
                    for tid in identities:
                        if identities[tid]["tgid"] == item["tid"]:
                            positions[tid] = group
                    if item["tid"] == 100:
                        # A child born after the initial host census must be
                        # discovered and moved on the following pass.
                        identities[300] = {"tid": 300, "tgid": 300, "start": "300", "ppid": 100}
                        positions[300] = "alphaclaw-host"
                        (proc / "300/task/300").mkdir(parents=True)
                else:
                    positions[item["tid"]] = group
                    if item["tid"] == 101:
                        # A late thread inherits the temporary domain root.
                        identities[103] = {"tid": 103, "tgid": 100, "start": "103", "ppid": 1}
                        positions[103] = "conductor"
                return True

            with patch.object(repair, "PROC", proc), \
                    patch.object(repair, "identity", side_effect=lambda tid: copy.copy(identities.get(tid))), \
                    patch.object(repair, "members", side_effect=members), \
                    patch.object(instance, "move", side_effect=move):
                instance.restore()
        self.assertEqual(positions[100], "conductor/workload")
        self.assertEqual(positions[101], "conductor/host-runtime")
        self.assertEqual(positions[102], "conductor/workload")
        self.assertEqual(positions[103], "conductor/workload")
        self.assertEqual(positions[300], "conductor/workload")
        self.assertEqual(positions[200], "alphaclaw-host")
        self.assertEqual(positions[400], "alphaclaw-host")


if __name__ == "__main__":
    unittest.main()
