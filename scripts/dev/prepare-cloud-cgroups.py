#!/usr/bin/env python3
"""Prepare the inspected Conductor cloud layout for Docker memory controllers.

Read-only unless --apply is supplied. This is a development VM repair, never a
workspace startup hook. It deliberately refuses other cgroup topologies. See
docs/cloud-testing.md and the kernel cgroup-v2 documentation's Threads section.
"""

import argparse
import errno
import json
import os
from pathlib import Path
import sys
import time


ROOT = Path("/sys/fs/cgroup")
PROC = Path("/proc")
CONDUCTOR = ("conductor", "conductor/workload", "conductor/host-runtime")
PREPARED = (*CONDUCTOR, "alphaclaw-host", "alphaclaw-docker")
CPU_KNOBS = ("cpu.max", "cpu.weight", "cpu.max.burst", "cpu.idle")
ROOT_LIMITS = (*CPU_KNOBS, "memory.max", "memory.swap.max", "pids.max")
MAX_PASSES = 100


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def read(path):
    return path.read_text().strip()


def write(path, value):
    # cgroup.procs accepts exactly one PID in each write.
    path.write_text(str(value))


def members(group, kind="cgroup.threads"):
    return set(map(int, read(ROOT / group / kind).split()))


def parse_stat(raw):
    head, separator, tail = raw.rpartition(")")
    fields = tail.split()
    require(separator and len(fields) >= 20, "Malformed /proc stat")
    return {"tid": int(head.split("(", 1)[0]), "ppid": int(fields[1]),
            "start": str(int(fields[19]))}


def identity(tid):
    try:
        before = parse_stat(read(PROC / str(tid) / "stat"))
        status = read(PROC / str(tid) / "status")
        tgid = int(next(line.split()[1] for line in status.splitlines()
                        if line.startswith("Tgid:")))
        after = parse_stat(read(PROC / str(tid) / "stat"))
        if before["tid"] != tid or after["tid"] != tid or before["start"] != after["start"]:
            return None
        return {**after, "tgid": tgid}
    except (FileNotFoundError, ProcessLookupError):
        return None


def same_identity(left, right):
    return bool(left and right and all(left[key] == right[key]
                                       for key in ("tid", "tgid", "start")))


def group_of(tid):
    try:
        lines = read(PROC / str(tid) / "cgroup").splitlines()
        return next(line[4:].lstrip("/") for line in lines if line.startswith("0::/"))
    except (FileNotFoundError, ProcessLookupError):
        return None


def topology():
    groups = {}
    # Only the dedicated Docker branch may have arbitrary descendants on reruns.
    paths = [ROOT]
    paths.extend(p for p in ROOT.iterdir() if p.is_dir())
    for path in list(paths[1:]):
        if path.name != "alphaclaw-docker":
            paths.extend(p for p in path.rglob("*") if p.is_dir())
    for path in paths:
        name = str(path.relative_to(ROOT)) if path != ROOT else ""
        groups[name] = {key: read(path / key) for key in
                        ("cgroup.type", "cgroup.subtree_control", *ROOT_LIMITS)
                        if (path / key).exists()}
    return groups


def classify_layout(groups, root_pids):
    names = set(groups) - {""}
    root = groups[""]
    if names == set(PREPARED):
        expected_types = {"": "domain", "conductor": "domain threaded",
                          "conductor/workload": "threaded",
                          "conductor/host-runtime": "threaded",
                          "alphaclaw-host": "domain", "alphaclaw-docker": "domain"}
        require(all(groups[name]["cgroup.type"] == kind
                    for name, kind in expected_types.items()), "Unexpected prepared group types")
        require(not root_pids, "Prepared domain root must have no local processes")
        require({"cpu", "memory", "pids"} <= set(root["cgroup.subtree_control"].split()),
                "Prepared root is missing required controllers")
        require(groups["conductor"]["cgroup.subtree_control"] == "cpu",
                "Unexpected Conductor controllers")
        require(all(not groups[name]["cgroup.subtree_control"] for name in CONDUCTOR[1:]),
                "Unexpected controllers below Conductor leaves")
        require(all("cpu.max" in groups[name] and "cpu.weight" in groups[name]
                    for name in ("", *CONDUCTOR)), "Missing prepared CPU controls")
        return "prepared"
    require(names == set(CONDUCTOR), "Unexpected cgroup topology; inspect this VM before repair")
    require(root["cgroup.type"] == "domain threaded" and
            root["cgroup.subtree_control"] == "cpu", "Unexpected namespace root configuration")
    require(all(groups[name]["cgroup.type"] == "threaded" for name in CONDUCTOR),
            "Expected the original threaded Conductor layout")
    require(groups["conductor"]["cgroup.subtree_control"] == "cpu" and
            all(not groups[name]["cgroup.subtree_control"] for name in CONDUCTOR[1:]),
            "Unexpected Conductor controllers")
    require(all("cpu.max" in groups[name] and "cpu.weight" in groups[name]
                for name in ("", *CONDUCTOR)), "Missing CPU controls")
    return "original"


def process_defaults(records):
    """Group processes by leader identity; the leader's leaf wins for new TIDs."""
    defaults = {}
    for item in records.values():
        if item["group"] not in CONDUCTOR:
            continue
        key = (item["tgid"], item["processStart"])
        if key not in defaults or item["tid"] == item["tgid"]:
            defaults[key] = item["group"]
    return defaults


def assert_no_split_domains(records):
    locations = {}
    for item in records.values():
        locations.setdefault((item["tgid"], item["processStart"]), set()).add(
            item["group"] in CONDUCTOR)
    require(all(len(value) == 1 for value in locations.values()),
            "A process spans root and Conductor; this repair cannot preserve that placement")


class Evidence:
    def __init__(self, directory, snapshot):
        self.directory = directory
        directory.mkdir(parents=True, exist_ok=False)
        self.save("before.json", snapshot)

    def save(self, name, value):
        with (self.directory / name).open("x") as stream:
            json.dump(value, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())

    def append(self, name, value):
        with (self.directory / name).open("a") as stream:
            stream.write(json.dumps(value) + "\n")
            stream.flush()
            os.fsync(stream.fileno())

    def phase(self, message):
        self.append("phases.jsonl", {"at": time.time(), "phase": message})
        print(message, flush=True)


class Repair:
    def __init__(self, groups):
        self.groups = groups
        self.records = {}
        self.evidence = None

    def remember(self, tid, group):
        item = identity(tid)
        leader = identity(item["tgid"]) if item else None
        if not item or not leader or not same_identity(identity(tid), item):
            return
        key = (tid, item["start"])
        if key not in self.records:
            record = {**item, "processStart": leader["start"], "group": group}
            if self.evidence:
                self.evidence.append("discovered-threads.jsonl", record)
            self.records[key] = record

    def capture(self):
        for group in ("", *CONDUCTOR):
            for tid in members(group):
                self.remember(tid, group)
        assert_no_split_domains(self.records)

    def move(self, group, expected, *, thread=False):
        if not expected or not same_identity(identity(expected["tid"]), expected):
            return False
        try:
            write(ROOT / group / ("cgroup.threads" if thread else "cgroup.procs"), expected["tid"])
            return True
        except OSError as exc:
            if exc.errno != errno.ESRCH:
                raise
            return False

    def remember_process(self, pid):
        try:
            for task in (PROC / str(pid) / "task").iterdir():
                group = group_of(int(task.name))
                # A process already evacuated by another listed TID can now
                # have new threads in root; those inherit its saved default.
                # They are not original root processes and must not be recorded
                # as such when restoring the separate resource domains.
                if group in CONDUCTOR:
                    self.remember(int(task.name), group)
        except (FileNotFoundError, ProcessLookupError):
            pass

    def evacuate(self):
        for group in reversed(CONDUCTOR):
            for attempt in range(MAX_PASSES):
                for tid in members(group):
                    item = identity(tid)
                    if item:
                        self.remember_process(item["tgid"])
                        leader = identity(item["tgid"])
                        if leader:
                            self.move("", leader)
                try:
                    (ROOT / group).rmdir()
                    break
                except OSError as exc:
                    if exc.errno != errno.EBUSY or attempt == MAX_PASSES - 1:
                        raise
        write(ROOT / "cgroup.subtree_control", "-cpu")
        require(read(ROOT / "cgroup.type") == "domain", "Namespace root did not become a domain")

    def create_domains(self):
        for group in ("alphaclaw-host", "conductor", "alphaclaw-docker"):
            (ROOT / group).mkdir()
        # Move ourselves first: children spawned during this phase inherit host.
        self.move("alphaclaw-host", identity(os.getpid()))
        for _ in range(MAX_PASSES):
            for pid in members("", "cgroup.procs"):
                item = identity(pid)
                if item:
                    self.move("alphaclaw-host", item)
            if not members("", "cgroup.procs"):
                break
        else:
            raise RuntimeError("Namespace root did not empty")
        # Never enable cpu before draining root: that recreates domain threaded.
        write(ROOT / "cgroup.subtree_control", "+cpu +memory +pids +io")
        for knob in CPU_KNOBS:
            if knob in self.groups["conductor"]:
                write(ROOT / "conductor" / knob, self.groups["conductor"][knob])
        for group in CONDUCTOR[1:]:
            (ROOT / group).mkdir()
            write(ROOT / group / "cgroup.type", "threaded")
        write(ROOT / "conductor/cgroup.subtree_control", "+cpu")
        for group in CONDUCTOR[1:]:
            for knob in CPU_KNOBS:
                if knob in self.groups[group]:
                    write(ROOT / group / knob, self.groups[group][knob])

    def restore(self):
        defaults = process_defaults(self.records)
        attempted = set()
        # Include new children only when their still-live parent has a known
        # Conductor identity. Unrelated host processes must remain in host.
        for _ in range(MAX_PASSES):
            for pid in members("alphaclaw-host", "cgroup.procs"):
                item = identity(pid)
                parent = identity(item["ppid"]) if item else None
                key = (pid, item["start"]) if item else None
                parent_key = (parent["tid"], parent["start"]) if parent else None
                if key not in defaults and parent_key in defaults:
                    defaults[key] = defaults[parent_key]
            pending = set(defaults) - attempted
            if not pending:
                break
            for pid, start in pending:
                attempted.add((pid, start))
                default = defaults[(pid, start)]
                leader = identity(pid)
                if not leader or leader["start"] != start:
                    continue
                if not self.move("conductor", leader):
                    continue
                try:
                    tids = [int(task.name) for task in (PROC / str(pid) / "task").iterdir()]
                except (FileNotFoundError, ProcessLookupError):
                    continue
                for tid in tids:
                    item = identity(tid)
                    if item and item["tgid"] == pid:
                        saved = self.records.get((tid, item["start"]))
                        self.move(saved["group"] if saved else default, item, thread=True)
        else:
            raise RuntimeError("Conductor descendants did not settle during restoration")
        # Threads created during migration may have inherited the domain root.
        for tid in members("conductor"):
            item = identity(tid)
            leader = identity(item["tgid"]) if item else None
            if item and leader:
                default = defaults.get((leader["tid"], leader["start"]))
                saved = self.records.get((tid, item["start"]))
                if default:
                    self.move(saved["group"] if saved else default, item, thread=True)

    def verify(self):
        current = topology()
        require(classify_layout(current, members("", "cgroup.procs")) == "prepared",
                "Prepared layout verification failed")
        for group in ("", *CONDUCTOR):
            for knob in ROOT_LIMITS if not group else CPU_KNOBS:
                if knob in self.groups[group]:
                    require(current[group].get(knob) == self.groups[group][knob],
                            f"Control changed: {group or '/'} {knob}")
        preserved = 0
        for item in self.records.values():
            if same_identity(identity(item["tid"]), item):
                expected = item["group"] or "alphaclaw-host"
                require(group_of(item["tid"]) == expected,
                        f"Thread placement changed: {item['tid']} expected {expected}")
                preserved += 1
        return {"groups": current, "survivingThreadsVerified": preserved,
                "observedThreads": len(self.records)}

    def apply(self, directory):
        self.capture()
        self.evidence = Evidence(directory, {"at": time.time(), "groups": self.groups,
                                            "threads": list(self.records.values())})
        try:
            require(topology() == self.groups, "Cgroup controls changed since inspection")
            self.evidence.phase("Saved topology, CPU controls, and thread identities")
            self.evacuate()
            self.evidence.phase("Removed old threaded groups; root is a domain")
            self.create_domains()
            self.evidence.phase("Created domain siblings and restored Conductor CPU controls")
            self.restore()
            result = self.verify()
            self.evidence.save("after.json", result)
            self.evidence.phase("Verified controls and all surviving saved thread placements")
            return result
        except Exception as exc:
            self.evidence.phase(f"FAILED: {type(exc).__name__}: {exc}")
            raise RuntimeError(f"Repair stopped; inspect {directory} before any further cgroup changes") from exc


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--apply", action="store_true", help="Apply the exact known-layout repair as root")
    action.add_argument("--check", action="store_true", help="Inspect without changing anything (the default)")
    parser.add_argument("--evidence-dir", type=Path, help="New directory for immutable before/after evidence")
    args = parser.parse_args(argv)
    groups = topology()
    layout = classify_layout(groups, members("", "cgroup.procs"))
    if layout == "prepared" or not args.apply:
        print(json.dumps({"layout": layout, "changed": False, "groups": groups}, indent=2))
        return 0
    require(os.geteuid() == 0, "--apply requires sudo")
    require({"cpu", "memory", "pids", "io"} <= set(read(ROOT / "cgroup.controllers").split()),
            "Namespace is missing required delegated controllers")
    for proc in PROC.iterdir():
        if proc.name.isdigit():
            try:
                comm = read(proc / "comm")
                require(comm not in ("dockerd", "runc") and not comm.startswith("containerd"),
                        "Stop the existing Docker daemon and containers before repairing this layout")
            except (FileNotFoundError, ProcessLookupError):
                pass
    directory = args.evidence_dir or Path(".context/docker") / (
        time.strftime("cgroup-repair-%Y%m%dT%H%M%SZ", time.gmtime()) + f"-{os.getpid()}")
    result = Repair(groups).apply(directory)
    print(json.dumps({"layout": "prepared", "changed": True, "evidence": str(directory),
                      "survivingThreadsVerified": result["survivingThreadsVerified"]}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"cgroup preparation refused or failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
