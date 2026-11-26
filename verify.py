"""One clean local run of the Valkey replacement scenario."""

import argparse
import errno
import hashlib
import json
import os
import platform
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parent
RUN_LABEL = "infra-recovery-lab.run"
WINDOW = 30


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(argv, *, timeout=15, capture=True, check=True, env=None):
    result = subprocess.run(
        argv, timeout=timeout, capture_output=capture, text=True, env=env, stdin=subprocess.DEVNULL
    )
    if check and result.returncode:
        detail = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(f"{' '.join(argv[:4])}: exit {result.returncode} {detail}".rstrip())
    return result


def local_docker():
    context = os.environ.get("DOCKER_CONTEXT")
    host = os.environ.get("DOCKER_HOST")
    if context or not host:
        host = run([
            "docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}",
            *([context] if context else []),
        ]).stdout.strip()
    require(host.startswith("unix:///") and Path(host.removeprefix("unix://")).is_socket(),
            f"A local Docker Unix socket is required; got {host!r}")
    return host


def validate_replacement_plan(details, *, wrong_volume):
    expected = ["docker_container.valkey"]
    if wrong_volume:
        expected.append("docker_volume.empty[0]")
    resources = details["resource_changes"]
    changes = [(r["address"], r["change"]["actions"]) for r in resources
               if r["change"]["actions"] != ["no-op"]]
    require(details.get("errored") is False
            and not details.get("deferred_changes")
            and not any(r.get("previous_address") or r["change"].get("importing") for r in resources)
            and all(c["actions"] == ["no-op"] for c in details.get("output_changes", {}).values())
            and sorted(changes) == [(address, ["create"]) for address in expected],
            f"Refusing replacement plan: {changes!r}")
    return expected


def require_recovered_value(reply, expected):
    require(isinstance(reply, list) and len(reply) == 2 and reply[0] == "PONG", "Expected PONG and GET reply")
    require(reply[1] is not None, "After: PONG; GET=KEY_MISSING")
    require(reply[1] == expected, "After: PONG; GET=VALUE_MISMATCH")


class Lab:
    def __init__(self, *, wrong_volume=False):
        self.name = f"infra-recovery-{uuid4().hex}"
        self.empty_volume = f"{self.name}-empty"
        self.wrong_volume = wrong_volume
        self.state = ROOT / ".runs" / self.name
        self.host = local_docker()
        # Both CLI and provider use the same explicit endpoint throughout the run.
        self.docker_env = {k: v for k, v in os.environ.items() if k not in {"DOCKER_CONTEXT", "DOCKER_HOST"}}
        self.tofu_env = {k: v for k, v in self.docker_env.items() if not k.startswith(("TF_", "TOFU_"))}
        self.tofu_env["TF_IN_AUTOMATION"] = "1"
        self.tofu_env["TF_CLI_CONFIG_FILE"] = str(self.state / "cli.tfrc")
        self.client = None

    def docker(self, *args, **kwargs):
        return run(["docker", "--host", self.host, *args], env=self.docker_env, **kwargs)

    def tofu(self, *args, **kwargs):
        return run(["tofu", f"-chdir={self.state}", *args], env=self.tofu_env, **kwargs)

    def init(self):
        for file in ("main.tf", ".terraform.lock.hcl"):
            shutil.copy2(ROOT / file, self.state / file)
        (self.state / "cli.tfrc").touch()
        lock_hash = hashlib.sha256((self.state / ".terraform.lock.hcl").read_bytes()).hexdigest()
        mirror = self.state.parent / f"providers-{sys.platform}-{platform.machine()}-{lock_hash}"
        flags = ["init", "-input=false", "-no-color", "-lockfile=readonly"]
        if mirror.is_dir():
            self.tofu(*flags, f"-plugin-dir={mirror}", timeout=180, capture=False)
        else:
            self.tofu(*flags, timeout=180, capture=False)
            # Publish only a complete mirror; parallel first runs may both bootstrap it.
            staging = self.state / "mirror"
            shutil.copytree(self.state / ".terraform/providers", staging)
            try:
                staging.rename(mirror)
            except OSError as exc:
                if exc.errno not in (errno.EEXIST, errno.ENOTEMPTY) or not mirror.is_dir():
                    raise

    def resources(self, kind, *, owned=False):
        # Use full IDs for container/network deletion, but names for absence checks and volumes.
        args = [kind, "ls"]
        if kind == "container":
            args.append("--all")
        if owned:
            args += ["--filter", f"label={RUN_LABEL}={self.name}"]
        column = "Names" if kind == "container" else "Name"
        if owned and kind != "volume":
            column = "ID"
            args.append("--no-trunc")
        return self.docker(*args, "--format", f"{{{{.{column}}}}}").stdout.splitlines()

    def assert_absent(self):
        for kind in ("container", "network", "volume"):
            names = {f"{self.name}-valkey", f"{self.name}-client"} if kind == "container" else {self.name}
            if kind == "volume":
                names.add(self.empty_volume)
            require(not (names.intersection(self.resources(kind)) or self.resources(kind, owned=True)),
                    f"{kind} still exists for {self.name}")

    def cleanup(self):
        errors = []
        for kind in ("container", "network", "volume"):
            try:
                for resource in self.resources(kind, owned=True):
                    try:
                        flags = ["--force"] if kind == "container" else []
                        self.docker(kind, "rm", *flags, resource)
                    except Exception as exc:
                        errors.append(str(exc))
            except Exception as exc:
                errors.append(str(exc))
        try:
            self.assert_absent()
        except Exception as exc:
            errors.append(str(exc))
        require(not errors, f"Cleanup failed; kept {self.state}: {'; '.join(errors)}")
        shutil.rmtree(self.state)
        print("Cleanup OK: client, Valkey, network, all run volumes and local state absent")

    def inspect(self, kind, name):
        return json.loads(self.docker(kind, "inspect", name).stdout)[0]

    def container(self, role):
        data = self.inspect("container", f"{self.name}-{role}")
        settings = data["NetworkSettings"]
        require(data["Config"]["Labels"].get(RUN_LABEL) == self.name and data["State"]["Running"],
                f"{role} is not a running container of this run")
        require(set(settings["Networks"]) == {self.name} and not any((settings["Ports"] or {}).values()),
                f"{role} must be on the run network only, with no published ports")
        return data

    def server(self):
        data = self.container("valkey")
        mounts = [m for m in data["Mounts"] if m["Destination"] == "/data"]
        require(len(mounts) == 1 and mounts[0]["Type"] == "volume" and mounts[0]["RW"],
                "Valkey /data must be a writable volume mount")
        address = data["NetworkSettings"]["Networks"][self.name]["IPAddress"]
        require(address, "Valkey has no internal IPv4 address")
        return data["Id"], mounts[0]["Name"], address, data["State"]["StartedAt"]

    def cli(self, address, *args, timeout=10):
        return self.docker(
            "exec", self.client, "valkey-cli", "-3", "--json", "-e", "-t", "0.5", "-h", address,
            *args, timeout=timeout, check=False,
        )

    @staticmethod
    def connect_error(result, address):
        prefix = f"Could not connect to Valkey at {address}:6379: "
        return (result.returncode == 1 and not result.stdout
                and result.stderr.strip() in {prefix + msg for msg in (
                    "Connection refused", "Connection timed out", "Operation timed out",
                    "No route to host", "Network is unreachable",
                )})

    @staticmethod
    def reply(result):
        require(result.returncode == 0 and not result.stderr,
                f"valkey-cli failed: exit {result.returncode}, {(result.stderr or result.stdout).strip()}")
        return json.loads(result.stdout)

    def ready(self, address, deadline, *args):
        while (remaining := deadline - time.monotonic()) > 0:
            result = self.cli(address, *args, timeout=remaining)
            # With -e, valkey-cli prints server errors to stderr even under --json.
            loading = result.returncode == 1 and not result.stdout and result.stderr.startswith("LOADING ")
            if self.connect_error(result, address) or loading:
                time.sleep(min(0.1, max(0, deadline - time.monotonic())))
                continue
            reply = self.reply(result)
            require(time.monotonic() <= deadline, "Valkey readiness/read deadline exceeded")
            return reply
        raise TimeoutError("Valkey readiness/read deadline exceeded")

    def verify(self):
        print(f"Run: {self.name}")
        self.assert_absent()
        self.state.mkdir(parents=True)
        try:
            self.scenario()
        finally:
            self.cleanup()

    def scenario(self):
        self.init()
        variables = (f"-var=run_name={self.name}", f"-var=docker_host={self.host}")
        self.tofu("apply", "-input=false", "-no-color", "-auto-approve", *variables, timeout=300)

        network = self.inspect("network", self.name)
        require(network["Internal"], "Docker network must be internal")
        self.client = self.container("client")["Id"]
        old_id, old_volume, old_address, _ = self.server()
        require(old_volume == self.name, "Unexpected initial data volume")
        print(f"Before: id={old_id} volume={old_volume} address={old_address}")
        require(self.ready(old_address, time.monotonic() + WINDOW, "PING") == "PONG", "Expected PONG")

        expected_config = {"appendonly": "yes", "appendfsync": "always", "dir": "/data",
                           "appenddirname": "appendonlydir", "appendfilename": "appendonly.aof", "save": ""}
        config = self.reply(self.cli(old_address, "CONFIG", "GET", *expected_config))
        require(config == expected_config, f"Unexpected effective Valkey configuration: {config!r}")
        key, value = f"lab:{self.name}", f"synthetic:{uuid4().hex}"
        require(self.reply(self.cli(old_address, "SET", key, value)) == "OK", "SET not acknowledged")
        require(self.reply(self.cli(old_address, "GET", key)) == value, "Initial GET did not match")
        self.docker("exec", old_id, "test", "-s", "/data/appendonlydir/appendonly.aof.manifest")
        self.docker("exec", old_id, "test", "-s", "/data/appendonlydir/appendonly.aof.1.incr.aof")
        print("Before: PONG; AOF/always on the data volume; SET acknowledged and initial GET matched")

        self.docker("container", "rm", "--force", old_id)
        down = self.cli(old_address, "PING", timeout=3)
        require(self.connect_error(down, old_address),
                f"Expected a connection failure from the working client; exit={down.returncode}, "
                f"stdout={down.stdout.strip()!r}, stderr={down.stderr.strip()!r}")
        print(f"Between: {down.stderr.strip()}")

        if self.wrong_volume:
            require(self.empty_volume not in self.resources("volume"), "Replacement volume already exists")
            variables += ("-var=wrong_volume=true",)
        plan = "replacement.tfplan"
        self.tofu("plan", "-input=false", "-no-color", f"-out={plan}", *variables, timeout=60)
        details = json.loads(self.tofu("show", "-json", plan).stdout)
        creates = validate_replacement_plan(details, wrong_volume=self.wrong_volume)
        print(f"Plan OK: create only {', '.join(creates)}")
        self.tofu("apply", "-input=false", "-no-color", plan, timeout=60, capture=False)

        new_id, new_volume, new_address, started_at = self.server()
        print(f"After: id={new_id} volume={new_volume} address={new_address}")
        expected_volume = self.empty_volume if self.wrong_volume else old_volume
        require(new_id != old_id, "Expected a new Valkey container ID")
        require(new_volume == expected_volume, f"Expected /data on {expected_volume}, got {new_volume}")
        require(self.inspect("network", self.name)["Id"] == network["Id"], "Original network changed")
        for volume in {old_volume, expected_volume}:
            require((self.inspect("volume", volume)["Labels"] or {}).get(RUN_LABEL) == self.name,
                    f"Volume {volume} is not labelled for this run")
        print(f"After: original volume {old_volume} still exists")
        # Compare timestamps from the same Docker engine clock (including Docker Desktop's VM).
        sampled_at = time.monotonic()
        engine_now = self.docker("info", "--format", "{{.SystemTime}}").stdout.strip()
        elapsed = (datetime.fromisoformat(engine_now) - datetime.fromisoformat(started_at)).total_seconds()
        require(elapsed >= 0, "Docker engine clock predates the replacement start")
        deadline = sampled_at + WINDOW - elapsed
        # EVAL_RO executes both commands on one new connection and cannot write.
        reply = self.ready(new_address, deadline, "EVAL_RO",
                           "return {redis.call('PING'), redis.call('GET', KEYS[1])}", "1", key)
        require_recovered_value(reply, value)
        duration = WINDOW - (deadline - time.monotonic())
        print(f"After: PONG; GET matched the exact pre-replacement value ({duration:.2f}s / {WINDOW}s)")


def interrupted(signum, _frame):
    raise InterruptedError(f"Interrupted by signal {signum}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wrong-volume", action="store_true", help="Attach a new empty volume during replacement")
    args = parser.parse_args()
    sys.stdout.reconfigure(line_buffering=True)
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, interrupted)
    try:
        Lab(wrong_volume=args.wrong_volume).verify()
    except Exception as error:
        sys.exit(f"verify: {error}")
