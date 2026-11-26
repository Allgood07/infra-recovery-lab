terraform {
  required_version = ">= 1.9.0"
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "3.9.0"
    }
  }
}

variable "docker_host" {
  type = string
}

variable "run_name" {
  type = string
}

variable "wrong_volume" {
  type    = bool
  default = false
}

provider "docker" {
  host = var.docker_host
}

locals {
  image     = "valkey/valkey:8.1.6-alpine@sha256:1cb6b20b70d927560cc4cc5397b5f045e74aa603ff7696274778880bb6fadc75"
  run_label = "infra-recovery-lab.run"
}

resource "docker_image" "valkey" {
  name         = local.image
  keep_locally = true
}

resource "docker_network" "run" {
  name     = var.run_name
  driver   = "bridge"
  internal = true
  labels {
    label = local.run_label
    value = var.run_name
  }
}

resource "docker_volume" "data" {
  name   = var.run_name
  driver = "local"
  labels {
    label = local.run_label
    value = var.run_name
  }
}

resource "docker_volume" "empty" {
  count  = var.wrong_volume ? 1 : 0
  name   = "${var.run_name}-empty"
  driver = "local"
  labels {
    label = local.run_label
    value = var.run_name
  }
}

resource "docker_container" "valkey" {
  name           = "${var.run_name}-valkey"
  image          = docker_image.valkey.image_id
  remove_volumes = false
  log_driver     = "local"
  command = [
    # The provider rejects empty argv elements; Valkey needs `--save ""` to disable snapshots.
    "sh", "-c", "exec docker-entrypoint.sh valkey-server \"$@\" --save ''", "valkey-server",
    "--dir", "/data", "--protected-mode", "no",
    "--appendonly", "yes", "--appendfsync", "always",
    "--appenddirname", "appendonlydir", "--appendfilename", "appendonly.aof",
  ]
  mounts {
    type   = "volume"
    source = var.wrong_volume ? docker_volume.empty[0].name : docker_volume.data.name
    target = "/data"
  }
  networks_advanced {
    name = docker_network.run.name
  }
  labels {
    label = local.run_label
    value = var.run_name
  }
}

resource "docker_container" "client" {
  name       = "${var.run_name}-client"
  image      = docker_image.valkey.image_id
  entrypoint = ["sleep"]
  command    = ["infinity"]
  log_driver = "local"
  # Override the image's VOLUME so the client doesn't create an anonymous volume.
  mounts {
    type   = "tmpfs"
    target = "/data"
  }
  networks_advanced {
    name = docker_network.run.name
  }
  labels {
    label = local.run_label
    value = var.run_name
  }
}
